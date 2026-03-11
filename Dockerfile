FROM getcarrier/gatling_maven_runner:latest

WORKDIR /opt

RUN pip install alita-mcp==0.1.33
COPY config.json /root/.config/alita-mcp-client/config.json

COPY executor_mcp.sh /opt
COPY package.json /opt
COPY package-lock.json /opt
COPY mcp-local-server.js /opt
COPY errors_parser.py /opt


RUN apt-get update && apt-get install -y curl
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs jq \
    && npm install \
    && npm install -g @anthropic-ai/claude-code

ENTRYPOINT ["/opt/executor_mcp.sh"]