const { searchTextSnippets } = require("../utils");

function createDocsTools() {
  return [
    {
      name: "search_docs",
      description: "Search local project docs and README content for explanations.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"]
      },
      async execute(args = {}) {
        const snippets = searchTextSnippets(args.query, 3);
        return {
          query: args.query,
          results: snippets
        };
      }
    }
  ];
}

module.exports = {
  createDocsTools
};
