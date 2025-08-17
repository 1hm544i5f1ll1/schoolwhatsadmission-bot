# Use Node.js as the base image
FROM node:18

# Set the working directory
WORKDIR /app

# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libu2f-udev \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    lsb-release \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json to install dependencies
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy all source code to the working directory
COPY . .

# Expose port 3000 for the web server
EXPOSE 3000

# Start the Node.js app
CMD ["node", "index.js"]
