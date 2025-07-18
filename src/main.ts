import * as path from "path";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as cp from "child_process";
import * as readline from "readline";
import * as crypto from "crypto";
import * as treekill from "tree-kill";
import { BufferListStream } from "bl";

const KILL = 0;
const TALK = 1;

interface Command {
  readonly path: string;
  readonly args: string[];
  readonly cwd: string;
}

function getIPCHandle(command: Command): string {
  const scope = crypto
    .createHash("md5")
    .update(command.path)
    .update(command.args.toString())
    .update(command.cwd)
    .digest("hex");

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\daemon-${scope}`;
  } else {
    return path.join(
      process.env["XDG_RUNTIME_DIR"] || os.tmpdir(),
      `daemon-${scope}.sock`
    );
  }
}

export async function createServer(handle: string): Promise<net.Server> {
  return new Promise((c, e) => {
    const server = net.createServer();

    server.on("error", e);
    server.listen(handle, () => {
      server.removeListener("error", e);
      c(server);
    });
  });
}

export function createConnection(handle: string): Promise<net.Socket> {
  return new Promise((c, e) => {
    const socket = net.createConnection(handle, () => {
      socket.removeListener("error", e);
      c(socket);
    });

    socket.once("error", e);
  });
}

export function spawnCommand(server: net.Server, command: Command, options: Options): void {
  const clients = new Set<net.Socket>();
  const bl = new BufferListStream();
  const child = cp.spawn(command.path, command.args, {
    shell: process.platform === "win32",
    windowsHide: true,
  });

  const onData = (data) => {
    bl.append(data);

    if (bl.length > 100_000_000) {
      // buffer caps at 100MB
      bl.consume(bl.length - 100_000_000);
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  let justSpawned = true;
  setTimeout(() => justSpawned = false, 210);

  let childExitCode: number | undefined;
  let childSignal: string | undefined;

  server.on("connection", (socket) => {
    socket.on("data", (buffer) => {
      const command = buffer[0];

      if (command === KILL) {
        treekill(child.pid);
      } else if (command === TALK) {
        const bufferStream = bl.duplicate();

        bufferStream.pipe(socket, { end: false });
        bufferStream.on("end", () => {
          if (childExitCode !== undefined || childSignal !== undefined) {
            const exitCode = childExitCode ?? 1;

            for (const client of clients) {
              client.end(new Uint8Array([exitCode]));
            }

            socket.write(`[deemon] Daemon was stopped when client attached (exit code ${childExitCode}, signal ${childSignal}).\n`);
            socket.end(new Uint8Array([exitCode]));
            setTimeout(() => {
              server.close();
              process.exit(exitCode);
            }, 0); // windows needs a timeout
            return;
          }

          child.stdout.pipe(socket, { end: false });
          child.stderr.pipe(socket, { end: false });
          clients.add(socket);

          if (justSpawned) {
            setTimeout(() => socket.write("[deemon] Spawned build daemon. Press Ctrl-C to detach, Ctrl-D to kill.\n"), 200);
            justSpawned = false;
          } else {
            setTimeout(() => socket.write("[deemon] Attached to running build daemon. Press Ctrl-C to detach, Ctrl-D to kill.\n"), 0);
          }
        });
      }
    });

    socket.on("close", () => {
      if (clients.has(socket)) {
        child.stdout.unpipe(socket);
        child.stderr.unpipe(socket);
        clients.delete(socket);
      }
    });
  });

  child.on("close", (code: number | null, signal: string | null) => {
    if (options.wait && clients.size === 0) {
      childExitCode = code;
      childSignal = signal;
      return;
    }

    for (const client of clients) {
      client.end(new Uint8Array([code ?? 1]));
      client.destroy();
    }

    server.close();
    process.exit(code ?? 1);
  });
}

function spawnDaemon(command: Command, options: Options) {
  const args = [process.argv[1], '--daemon'];

  if (options.wait) {
    args.push('--wait');
  }

  args.push(command.path, ...command.args);
  cp.spawn(process.execPath, args, { detached: true, stdio: "ignore" });
}

async function connect(command: Command, handle: string, options: Options): Promise<net.Socket> {
  try {
    return await createConnection(handle);
  } catch (err) {
    if (options.attach && (err.code === "ENOENT" || err.code === "ECONNREFUSED")) {
      console.error("[deemon] No daemon running.");
      process.exit(1);
    } else if (err.code === "ECONNREFUSED") {
      await fs.promises.unlink(handle);
    } else if (err.code !== "ENOENT") {
      throw err;
    }

    spawnDaemon(command, options);
    await new Promise((c) => setTimeout(c, 200));
    return await createConnection(handle);
  }
}

interface Options {
  readonly daemon: boolean;
  readonly kill: boolean;
  readonly restart: boolean;
  readonly detach: boolean;
  readonly wait: boolean;
  readonly attach: boolean;
}

async function main(command: Command, options: Options): Promise<void> {
  const handle = getIPCHandle(command);

  if (options.daemon) {
    const server = await createServer(handle);
    return spawnCommand(server, command, options);
  }

  if (options.detach) {
    spawnDaemon(command, options);

    console.log("[deemon] Detached from build daemon.");

    if (options.wait) {
      console.log("[deemon] Daemon will wait for a client to connect before exiting.");
    }

    process.exit(0);
  }

  let socket = await connect(command, handle, options);

  if (options.kill) {
    socket.write(new Uint8Array([KILL]));
    return;
  }

  if (options.restart) {
    socket.write(new Uint8Array([KILL]));
    await new Promise((c) => setTimeout(c, 500));
    socket = await connect(command, handle, options);
  }

  socket.write(new Uint8Array([TALK]));
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on("keypress", (code) => {
    if (code === "\u0003") {
      // ctrl c
      console.log("[deemon] Detached from build daemon.");
      process.exit(0);
    } else if (code === "\u0004") {
      // ctrl d
      console.log("[deemon] Killed build daemon.");
      socket.write(new Uint8Array([KILL]));
      process.exit(0);
    }
  });

  let lastByte: Buffer | null = null;
  let lastByteTimer: NodeJS.Timeout | null = null;

  socket.on('data', (data) => {
    clearTimeout(lastByteTimer);
    if (data.length === 0) return;

    if (lastByte) {
      process.stdout.write(lastByte);
    }

    lastByte = data.slice(data.length - 1);

    if (data.length > 1) {
      process.stdout.write(data.slice(0, data.length - 1));
      lastByteTimer = setTimeout(() => process.stdout.write(lastByte), 100);
    }
  });

  socket.on("close", () => {
    const code = lastByte ? lastByte[0] : 0;
    console.log("[deemon] Build daemon exited with code", code);
    process.exit(code);
  });
}

if (process.argv.length < 3) {
  console.error(`Usage: npx deemon [OPTS] COMMAND [...ARGS]
Options:
  --kill     Kill the currently running daemon
  --detach   Detach the daemon
  --wait     Wait for a client to connect before exiting the daemon (only valid with --detach)
  --attach   Attach to the currently running daemon, exiting if it doesn't exist
  --restart  Restart the daemon`);
  process.exit(1);
}

const commandPathIndex = process.argv.findIndex(
  (arg, index) => !/^--/.test(arg) && index >= 2
);
const [commandPath, ...commandArgs] = process.argv.slice(commandPathIndex);
const command: Command = {
  path: commandPath,
  args: commandArgs,
  cwd: process.cwd(),
};

const optionsArgv = process.argv.slice(2, commandPathIndex);
const options: Options = {
  daemon: optionsArgv.some((arg) => arg === "--daemon"),
  kill: optionsArgv.some((arg) => arg === "--kill"),
  restart: optionsArgv.some((arg) => arg === "--restart"),
  detach: optionsArgv.some((arg) => arg === "--detach"),
  wait: optionsArgv.some((arg) => arg === "--wait"),
  attach: optionsArgv.some((arg) => arg === "--attach")
};

main(command, options).catch((err) => {
  console.error(err);
  process.exit(1);
});
