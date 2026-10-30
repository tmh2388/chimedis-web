# Chimedis dict (API + giao diện tĩnh) — chạy: node server.js, cổng 3001.
# Chạy ĐÚNG MỘT bản (có tác vụ nền trong tiến trình: học thuật ngữ, rà soát ngôn ngữ). Không ghi đĩa lúc chạy → không cần volume.
FROM node:22-slim
WORKDIR /app/backend
COPY backend/ ./
RUN npm ci --omit=dev --no-audit --no-fund
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
USER node
CMD ["node", "server.js"]
