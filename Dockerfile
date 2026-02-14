FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Cloud Run uses PORT env variable (default 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
