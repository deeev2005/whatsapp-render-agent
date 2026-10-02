FROM node:20-bookworm-slim

# Install git and ca-certificates for SSL verification
RUN apt-get update && apt-get install -y git ca-certificates --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Configure git to use https and handle SSL
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global http.sslVerify false

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
