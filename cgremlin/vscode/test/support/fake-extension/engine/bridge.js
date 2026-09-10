// A stand-in for the engine bundle the core builds, so B1 can be developed and tested before
// Stream A ships the real artifact. Its shape is the contract in the design's section 4.1.
module.exports = {
  ENGINE_VERSION: '0.0.1-fake',
  loadResolvedConfig: async (configPath, home) => ({
    configPath,
    stateDir: `${home}/.cgremlin-core`,
    socketPath: `${home}/.cgremlin-core/engine.sock`,
    sessionsDir: `${home}/.cgremlin-core/sessions`,
    worktreesDir: `${home}/.cgremlin-core/worktrees`,
    enginePidPath: `${home}/.cgremlin-core/engine.json`,
    engineLogPath: `${home}/.cgremlin-core/engine.log`,
    repos: [],
    me: 'fake-login',
  }),
};
