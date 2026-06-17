export function nodeExecutable(env = process.env) {
  return env.WAKEFIELD_NODE
    || env.WAKEFIELD_NODE_PATH
    || env.npm_node_execpath
    || process.execPath;
}

export function nodeCommandArgs(script, args = [], env = process.env) {
  return [nodeExecutable(env), script, ...args];
}
