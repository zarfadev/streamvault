#!/bin/bash
set -e

# ─── LOGGING SETUP ────────────────────────────────────────────────────────────
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "🚀 Starting StreamVault Deployment $(date)"

# ─── OS UPDATES & DEPENDENCIES ────────────────────────────────────────────────
echo "📦 Installing system dependencies..."
dnf update -y
dnf install -y git docker postgresql15 htop
dnf install -y ffmpeg # Amazon Linux 2023 usually has ffmpeg in default repos or EPEL

# ─── NODE.JS & PM2 ────────────────────────────────────────────────────────────
echo "🟢 Installing Node.js 20..."
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs
npm install -g pm2

# ─── DIRECTORY SETUP ──────────────────────────────────────────────────────────
echo "📂 Setting up app directory..."
mkdir -p /opt/streamvault
chown ec2-user:ec2-user /opt/streamvault
cd /opt/streamvault

# ─── APPLICATION SETUP (To be run as ec2-user) ────────────────────────────────
# Note: In a real CI/CD flow, you'd use a Deploy Key or Token.
# For now, we assume the repo is public or the key is already in the AMI.
sudo -u ec2-user bash << 'EOF'
cd /opt/streamvault
git clone https://github.com/TU-USUARIO/streamvault.git . || git pull origin main
npm ci --production

# Create necessary directories
mkdir -p logs uploads videos
EOF

# ─── PERSISTENCE SETUP ────────────────────────────────────────────────────────
echo "💾 Configuring PM2 to start on boot..."
env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ec2-user --hp /home/ec2-user
systemctl enable pm2-ec2-user

# ─── FINISH ──────────────────────────────────────────────────────────────────
echo "✅ StreamVault basic setup complete."
echo "⚠️  CRITICAL: You must manually create /opt/streamvault/.env before starting the app."
echo "Run: pm2 start ecosystem.config.js"
