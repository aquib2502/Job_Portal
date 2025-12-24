FROM node:18

WORKDIR /app

# Copy dependency files first (better caching)
COPY package*.json ./

RUN npm install

# Copy source code
COPY . .

# Compile TypeScript → JavaScript
RUN npm run build

# Auth service runs on 5000
EXPOSE 5000

CMD ["npm", "run", "start"]
