FROM node:20-bookworm-slim

# Install git and openssh-client
RUN apt-get update && apt-get install -y git openssh-client --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Force git to use HTTPS instead of SSH for GitHub
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
