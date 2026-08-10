module.exports = {
  apps: [
    {
      name: 'chimedis-api',
      cwd: '/var/www/chimedis/backend',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
    },
  ],
};
