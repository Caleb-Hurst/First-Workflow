require('dotenv').config();
const { Octokit } = require("@octokit/rest");
const { OpenAI } = require("openai");

const owner = "Caleb-Hurst";
const repo = "First-Workflow";
const label = "needs-test";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function run() {
  // List open issues with the label
  const issues = await octokit.issues.listForRepo({
    owner,
    repo,
    labels: label,
    state: "open",
    per_page: 100 // adjust as needed
  });

  if (!issues.data.length) {
    console.log(`No issues found with label "${label}".`);
    return;
  }

  for (const issue of issues.data) {
    const { number, title, body, labels } = issue;

    // MCP context for issue
    const mcp_context = {
      type: "github_issue",
      number,
      title,
      body,
      labels: labels.map(l => l.name),
      // Optionally add more fields (comments, links, etc.)
    };

    // LLM prompts
    const systemPrompt = "You are an expert GitHub issue analyst. Summarize the ticket in clear language for QA.";
    const userPrompt = JSON.stringify(mcp_context, null, 2);

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 300
      });

      const analysis = response.choices[0].message.content;
      console.log(`\n--- Issue #${number}: ${title} ---`);
      console.log(analysis);

      // Comment on the issue with the analysis
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: `LLM QA analysis:\n\n${analysis}`
      });
    } catch (error) {
      console.error(`Failed to analyze or comment on issue #${number}:`, error);
    }
  }
}

run().catch(console.error);
