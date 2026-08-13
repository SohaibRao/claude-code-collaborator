# Claude Code Collaborator — sync server (presence & coordination)
#   docker build -t ccc-sync .
#   docker run -p 7377:7377 -v ccc-data:/data -e CCC_SYNC_TOKEN=your-shared-secret ccc-sync
FROM node:24-alpine
WORKDIR /app
COPY server/sync-server.mjs ./server/
EXPOSE 7377
VOLUME /data
CMD ["node", "server/sync-server.mjs", "--port", "7377", "--state", "/data/state.json"]
