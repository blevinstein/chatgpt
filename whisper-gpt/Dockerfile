# Choose the Node.js image
FROM node:19

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN yarn install
RUN apt update
RUN apt install -y ffmpeg

# Copy source code and assets
COPY prompt prompt
COPY static static
COPY views views
COPY *.js ./

# TODO: Remove .env from docker image, use secrets
COPY .env ./

RUN TZ=UTC date > build-time.txt

# Start the app
CMD ["npm", "start"]

