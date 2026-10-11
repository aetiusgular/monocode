/**
 * A small `docker mcp catalog show mcp/docker-mcp-catalog --format json`,
 * in the shape Docker Desktop 4.94 / `docker mcp` 0.44 prints.
 */
export const CATALOG_FIXTURE = {
  ref: "mcp/docker-mcp-catalog",
  source: "docker",
  title: "Docker MCP Catalog",
  digest: "sha256:abc",
  servers: [
    {
      type: "remote",
      snapshot: {
        server: {
          name: "notion-remote",
          type: "remote",
          title: "Notion",
          description: "Read and write Notion pages and databases.",
          icon: "https://avatars.githubusercontent.com/u/4792552?v=4",
          remote: { url: "https://mcp.notion.com/mcp", transport_type: "http" },
          oauth: {
            providers: [
              { provider: "notion-remote", secret: "notion.token", env: "X" },
            ],
          },
          secrets: null,
          tools: [{ name: "notion-search", description: "Search" }],
          metadata: {
            category: "productivity",
            tags: ["notes", "docs"],
            owner: "notion",
          },
          readme: "https://example.com/readme",
        },
      },
    },
    {
      type: "remote",
      snapshot: {
        server: {
          name: "hugging-face",
          type: "remote",
          title: "Hugging Face",
          description: "Search models, datasets and Spaces.",
          icon: "https://huggingface.co/front/assets/huggingface_logo.svg",
          remote: { url: "https://huggingface.co/mcp", transport_type: "http" },
          oauth: null,
          secrets: null,
          tools: [
            { name: "hub_repo_search" },
            { name: "paper_search" },
            { name: "space_search" },
            { name: "hf_whoami" },
          ],
          metadata: { category: "ai", tags: ["ml"] },
        },
      },
    },
    {
      type: "server",
      image: "mcp/github@sha256:1",
      snapshot: {
        server: {
          name: "github",
          type: "server",
          title: "GitHub",
          description: "Issues, pull requests and code on GitHub.",
          image: "mcp/github@sha256:1",
          oauth: null,
          secrets: [
            { name: "github.personal_access_token", env: "GITHUB_TOKEN" },
          ],
          tools: [{ name: "create_issue" }, { name: "search_code" }],
          metadata: { category: "devops", tags: ["git"] },
        },
      },
    },
    {
      // Hidden from Discover: its sign-in cannot work through Docker.
      type: "server",
      snapshot: {
        server: {
          name: "grafbase",
          type: "remote",
          title: "Grafbase",
          description: "Grafbase.",
          remote: { url: "https://api.grafbase.com/mcp" },
          oauth: { providers: [{ provider: "grafbase" }] },
          metadata: {},
        },
      },
    },
    {
      type: "server",
      snapshot: {
        server: {
          name: "time",
          type: "server",
          title: "Time",
          description: "Current time and time zones.",
          image: "mcp/time",
          metadata: {},
        },
      },
    },
    {
      type: "server",
      image: "yashtekwani/gmail-mcp@sha256:2",
      snapshot: {
        server: {
          name: "gmail-mcp",
          type: "server",
          title: "Gmail",
          description: "Read and send Gmail messages.",
          image: "yashtekwani/gmail-mcp@sha256:2",
          oauth: null,
          secrets: [{ name: "gmail-mcp.password", env: "EMAIL_PASSWORD" }],
          config: [
            {
              name: "gmail-mcp",
              description: "Configure the Gmail connection",
              type: "object",
              properties: {
                email_address: {
                  type: "string",
                  description: "Your Gmail email address",
                },
                imap_host: { type: "string", description: "IMAP server" },
                api_token: { type: "string", description: "Not config" },
              },
              required: ["email_address"],
            },
          ],
          env: [
            { name: "EMAIL_ADDRESS", value: "{{gmail-mcp.email_address}}" },
          ],
          tools: [{ name: "send_email" }],
          metadata: { category: "communication" },
        },
      },
    },
    { type: "server", snapshot: { server: { name: "Bad Name!" } } },
    { type: "server" },
  ],
};
