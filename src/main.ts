import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as readline from 'readline';
import * as crypto from 'crypto';
import * as treekill from 'tree-kill';
const { BufferListStream } = require('bl');

interface Command {
	readonly path: string;
	readonly args: string[];
	readonly cwd: string;
}

function getIPCHandle(command: Command): string {
	const scope = crypto.createHash('md5')
		.update(command.path)
		.update(command.args.toString())
		.update(command.cwd)
		.digest('hex');

	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\daemon-${scope}`;
	} else {
		return path.join(process.env['XDG_RUNTIME_DIR'] || os.tmpdir(), `daemon-${scope}.sock`);
	}
}

export async function createServer(handle: string): Promise<net.Server> {
	return new Promise((c, e) => {
		const server = net.createServer();

		server.on('error', e);
		server.listen(handle, () => {
			server.removeListener('error', e);
			c(server);
		});
	});
}

export function createConnection(handle: string): Promise<net.Socket> {
	return new Promise((c, e) => {
		const socket = net.createConnection(handle, () => {
			socket.removeListener('error', e);
			c(socket);
		});

		socket.once('error', e);
	});
}

export function spawnCommand(server: net.Server, command: Command): void {
	const clients = new Set<net.Socket>();
	const bl = new BufferListStream();
	const child = cp.spawn(command.path, command.args, {
		shell: process.platform === 'win32',
		windowsHide: true
	});

	child.stdout.on('data', data => {
		bl.append(data);

		if (bl.length > 1_000_000) { // buffer caps at 1MB
			bl.consume(bl.length - 1_000_000);
		}
	});

	server.on('connection', socket => {
		const bufferStream = bl.duplicate();

		bufferStream.pipe(socket, { end: false });
		bufferStream.on('end', () => {
			child.stdout.pipe(socket);
			clients.add(socket);

			socket.on('data', () => {
				treekill(child.pid);
			});

			socket.on('close', () => {
				child.stdout.unpipe(socket);
				clients.delete(socket);
			});
		});
	});

	child.on('exit', () => {
		for (const client of clients) {
			client.destroy();
		}

		server.close();
		process.exit(0);
	});
}

async function connect(command: Command, handle: string): Promise<net.Socket> {
	try {
		return await createConnection(handle);
	} catch (err) {
		if (err.code === 'ECONNREFUSED') {
			await fs.promises.unlink(handle);
		} else if (err.code !== 'ENOENT') {
			throw err;
		}

		cp.spawn(process.execPath, [process.argv[1], '--daemon', command.path, ...command.args], {
			detached: true,
			stdio: 'ignore'
		});

		await new Promise(c => setTimeout(c, 200));
		return await createConnection(handle);
	}
}

interface Options {
	readonly daemon: boolean;
	readonly kill: boolean;
	readonly restart: boolean;
}

async function main(command: Command, options: Options): Promise<void> {
	const handle = getIPCHandle(command);

	if (options.daemon) {
		const server = await createServer(handle);
		return spawnCommand(server, command);
	}

	let socket = await connect(command, handle);

	if (options.kill) {
		socket.write('kill');
		return;
	}

	if (options.restart) {
		socket.write('kill');
		await new Promise(c => setTimeout(c, 500));
		socket = await connect(command, handle);
	}

	readline.emitKeypressEvents(process.stdin);

	if (process.stdin.isTTY && process.stdin.setRawMode) {
		process.stdin.setRawMode(true);
	}

	process.stdin.on('keypress', code => {
		if (code === '\u0003') { // ctrl c
			console.log('Disconnected from build daemon, it will stay running in the background.');
			process.exit(0);
		} else if (code === '\u0004') { // ctrl d
			console.log('Killed build daemon.');
			socket.write('kill');
			process.exit(0);
		}
	});

	socket.pipe(process.stdout);

	socket.on('close', () => {
		console.log('Build daemon exited.');
		process.exit(0);
	});
}

if (process.argv.length < 3) {
	console.error(`Usage: node daemon.js [OPTS] COMMAND [...ARGS]
Options:
  --kill     Kill the currently running daemon
  --restart  Restart the daemon`);
	process.exit(1);
}

const commandPathIndex = process.argv.findIndex((arg, index) => !/^--/.test(arg) && index >= 2);
const [commandPath, ...commandArgs] = process.argv.slice(commandPathIndex);
const command: Command = {
	path: commandPath,
	args: commandArgs,
	cwd: process.cwd()
};

const optionsArgv = process.argv.slice(2, commandPathIndex);
const options: Options = {
	daemon: optionsArgv.some(arg => arg === '--daemon'),
	kill: optionsArgv.some(arg => arg === '--kill'),
	restart: optionsArgv.some(arg => arg === '--restart')
};

main(command, options).catch(err => {
	console.error(err);
	process.exit(1);
});
