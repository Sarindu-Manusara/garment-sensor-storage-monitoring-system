const { createAnomalyTools } = require("./tools/anomalyTool");
const { createComparisonTools } = require("./tools/comparisonTool");
const { createDocsTools } = require("./tools/docsTool");
const { createGuidanceTools } = require("./tools/guidanceTool");
const { createHistoryTools } = require("./tools/historyTool");
const { createInfluenceTools } = require("./tools/influenceTool");
const { createLatestStatusTools } = require("./tools/latestStatusTool");
const { createPredictionTools } = require("./tools/predictionTool");
const { createThresholdTools } = require("./tools/thresholdTool");
const { createWarningTools } = require("./tools/warningTool");

function createToolRegistry(context) {
  const tools = [
    ...createLatestStatusTools(context),
    ...createHistoryTools(context),
    ...createAnomalyTools(context),
    ...createWarningTools(context),
    ...createPredictionTools(context),
    ...createComparisonTools(context),
    ...createGuidanceTools(context),
    ...createInfluenceTools(context),
    ...createThresholdTools(context),
    ...createDocsTools(context)
  ];

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    listTools() {
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }));
    },
    getTool(name) {
      return toolMap.get(name) || null;
    },
    async executeToolCall(call) {
      const tool = toolMap.get(call.name);
      if (!tool) {
        throw new Error(`Unknown chat tool: ${call.name}`);
      }

      const args = call.args && typeof call.args === "object" ? call.args : {};
      const result = await tool.execute(args);
      return {
        name: call.name,
        args,
        result
      };
    }
  };
}

module.exports = {
  createToolRegistry
};
