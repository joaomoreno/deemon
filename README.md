# deemon

[![npm version](https://badge.fury.io/js/deemon.svg)](https://badge.fury.io/js/deemon)

Utility to run a process in the background and attach to it

## Usage

```
npx deemon COMMAND [ARGS]
```

## Example 

```
npx deemon /bin/bash -c "while true; do date; sleep 1; done"
```

<kbd>Ctrl C</kbd> will stop the current session and leave the process running in the background. Simply run the same command again to attach to it:

```
npx deemon /bin/bash -c "while true; do date; sleep 1; done"
```

<kbd>Ctrl D</kbd> will stop the current session and the background process. You can also simply kill the background process with the  `--kill` flag:

```
npx deemon --kill /bin/bash -c "while true; do date; sleep 1; done"
```

Or you can force a restart of the background process and attach to that with the `--restart` flag:

```
npx deemon --restart /bin/bash -c "while true; do date; sleep 1; done"
```
