# Choose the Node.js image
FROM node:14

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN yarn install
RUN apt update
RUN apt install -y ffmpeg

# Copy the rest of the source code
COPY static static
COPY server.js ./

# Start the app
CMD ["npm", "start"]

