# Camoufox-compatible Apify image with the matching Firefox runtime.
FROM apify/actor-node-playwright-camoufox:24-1.60.0

COPY --chown=myuser:myuser package*.json Dockerfile ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && node -e "import('camoufox-js').then(m => console.log('camoufox-js OK:', Object.keys(m)))" \
    && node -e "import('playwright').then(m => console.log('playwright OK:', m.firefox ? 'firefox available' : 'firefox missing'))" \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser:myuser . ./

CMD ["node", "src/main.js"]
