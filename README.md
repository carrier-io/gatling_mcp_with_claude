# gatling_mcp
A docker container with alita-mcp inside to execute Gatling scripts, Claude automation, and provide a local MCP server with extensible tools.

## 1. How to Build the Container

Build the Docker image using:

```sh
docker build -t getcarrier/gatling_mcp:claude .
```

## 2. How to Start the Container

Run the container with required environment variables:

```sh
docker run -d -ti \
  -e GIT_USER=your_git_user \
  -e GIT_EMAIL=your_git_email \
  -e GIT_TOKEN=your_git_token \
  -e GIT_URL=git.epam.com \
  -e deployment_url=https://next.elitea.ai \
  -e auth_token=your_alita_token \
  -e project_id=your_alita_project \
  -e timeout=900 \
  -e CLAUDE_CODE_USE_BEDROCK=1 \
  -e AWS_ACCESS_KEY_ID=your_access_key \
  -e AWS_SECRET_ACCESS_KEY=your_secret_access_key \
  -e ANTHROPIC_MODEL=global.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  -e IS_SANDBOX=1 \
  -e AWS_REGION=us-east-1 \
  getcarrier/gatling_mcp:claude
```

### Parameter Descriptions
- **GIT_USER**: Username for Git authentication (used for private repo access)
- **GIT_EMAIL**: Email for Git commits
- **GIT_TOKEN**: Personal access token or password for Git
- **GIT_URL**: Git domain (without protocol, e.g. git.epam.com)
- **deployment_url**: Elitea deployment URL (overrides config.json)
- **auth_token**: Elitea authentication token (overrides config.json)
- **project_id**: Project ID (number, overrides config.json)
- **timeout**: Timeout for MCP operations (seconds, overrides config.json)
- **CLAUDE_CODE_USE_BEDROCK**: Set to 1 to enable Claude Bedrock integration
- **AWS_ACCESS_KEY_ID**: AWS access key for Bedrock
- **AWS_SECRET_ACCESS_KEY**: AWS secret access key for Bedrock
- **ANTHROPIC_MODEL**: Claude model identifier (e.g. global.anthropic.claude-sonnet-4-5-20250929-v1:0)
- **IS_SANDBOX**: Set to 1 to enable sandbox mode
- **AWS_REGION**: AWS region for Bedrock (e.g. us-east-1)


## 3. Using the MCP Server

The container runs a local MCP server (`mcp-local-server.js`) with a set of tools accessible via the MCP protocol. Key tools include:

- **execute_python_script**: Run a Python script with optional arguments.
- **execute_gatling_simulation**: Run a Gatling simulation via Maven. Supports custom simulation class, working directory, Maven executable, Gatling params, and timeout.
- **git_clone**: Clone a git repository by URL and checkout a specific branch. Optionally specify target directory.
- **git_pull**: Pull the latest changes from a git repository in a specified working directory.
- **git_commit_and_push**: Add, commit, and push all changes (except `target/` and `errors.json`) in a repo. Accepts a commit message.
- **get_errors**: Parse and group errors from Gatling simulation error logs. Accepts a working directory parameter.
- **claude_code**: Run Claude CLI with a user prompt. Returns only the last 20 lines of output. Uses Bedrock and Anthropic Claude model as configured by environment variables.

You can interact with these tools via the MCP protocol (e.g., using Elitea Agents).

## 4. Claude Integration

- **Claude CLI** is installed in the container and can be executed via the `claude_code` MCP tool.
- Claude is configured using Bedrock and Anthropic environment variables (see above).
- The `claude_code` tool allows you to run Claude CLI with a custom prompt, returning a concise summary (last 20 lines of output).
- Example usage: The tool runs `claude --permission-mode bypassPermissions -p "<your prompt>"` in the specified working directory.

## 5. Extending and Updating Tools

To add or update tools:
- Edit `mcp-local-server.js` and define a new handler method (e.g., `handleMyNewTool`).
- Register the tool in the `ListToolsRequestSchema` handler with its name, description, and input schema.
- Add a case for your tool in the `CallToolRequestSchema` handler to call your handler method.
- You can use GitHub Copilot or similar AI assistants to help generate or update tool code quickly and safely.

**Tip:** After editing or adding tools, rebuild the Docker image and restart the container.

## 6. Running alita-mcp with Claude Locally (Without Docker)

You can run the MCP server and Claude tools locally for development or debugging:

1. **Install Requirements:**
   - Python 3, Node.js 20+, Maven, and all dependencies from `package.json`.
   - Install `alita-mcp` Python package: `pip install alita-mcp==0.1.33`
   - Install Claude CLI globally (see Anthropic/Bedrock documentation).

2. **Prepare Configs:**
   - Copy and edit `config.json` to `~/.config/alita-mcp-client/config.json` (update `deployment_url`, `auth_token`, `project_id`, `timeout`, etc. as needed).

3. **Set Environment Variables:**
   - Export all required variables as shown in the Docker run command above.

4. **Configure Git Credentials:**
   - Run:
     ```sh
     git config --global credential.helper store
     echo "https://${GIT_USER}:${GIT_TOKEN}@${GIT_URL}/" > ~/.git-credentials
     git config --global user.email "${GIT_EMAIL}"
     git config --global user.name "${GIT_USER}"
     ```

5. **Start the MCP Server:**
   - Run:
     ```sh
     alita-mcp serve
     ```
   - Or, to use the local Node.js server:
     ```sh
     node mcp-local-server.js
     ```

6. **Usage:**
   - The same MCP tools (including Claude and Git tools) are available as in the Docker container.

## 7. Additional Information

- The container is based on `getcarrier/gatling_mcp:claude` and includes Node.js, Python, Maven, Claude CLI, and all dependencies for running Gatling and MCP tools.
- Git credentials are configured at startup for private repo access.
- The config file (`config.json`) is patched at runtime using environment variables for easy integration with CI/CD and cloud platforms.
- Error log parsing is handled by `errors_parser.py`, which can be extended for custom error formats.
- All scripts and server code are located in `/opt` inside the container.
- For troubleshooting, check container logs and the output of MCP tool invocations.

---

For more details, see the source files in this repository or contact the maintainers.
