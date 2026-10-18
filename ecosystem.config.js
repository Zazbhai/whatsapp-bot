module.exports = {
  apps: [
    {
      name: 'bot',
      script: 'server.js',
      env: {
        NODE_ENV: 'production'
      },
      restart_delay: 5000,
      max_restarts: 50,
      exp_backoff_restart_delay: 2000
    },
    {
      name: 'cf-redirect',
      script: 'bash',
      args: 'cloudflared.sh 3001',
      restart_delay: 5000,
      autorestart: true
    },
    {
      name: 'cf-dashboard',
      script: 'bash',
      args: 'cloudflared.sh 3000',
      restart_delay: 5000,
      autorestart: true
    }
  ]
};
