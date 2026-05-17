module.exports = {
  apps: [{
    name: 'codex',
    script: 'src/index.js',
    cwd: '/root/codexProapi',
    env: {
      NODE_ENV: 'production',
      PORT: 1455,
      PUBLIC_URL: 'https://27c.site',
    },
  }],
};
