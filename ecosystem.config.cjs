// PM2 进程管理配置
// 使用：pm2 start ecosystem.config.cjs
// 环境变量通过 .env 或命令行注入，不要写死在这里

module.exports = {
  apps: [
    {
      name: 'codex-proapi',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // 环境变量：从 .env 或 shell 继承，仅兜底默认值
      env: {
        NODE_ENV: 'production',
        PORT: 1455,
      },
      // 日志放在项目目录下，pm2 日志轮转自动处理
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // 合并日志，单文件更大更干净
      merge_logs: true,
    },
  ],
};
