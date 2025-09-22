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
    per_page: 100
  });

  if (!issues.data.length) {
    console.log(`No issues found with label "${label}".`);
    return;
  }

  for (const issue of issues.data) {
    const { number, title, body, labels } = issue;

    // Get issue comments to look for PR references
    const comments = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: number,
      per_page: 50
    });

    // Try to find PR reference in comments just changing small things

    let prNumber = null;
    for (const comment of comments.data) {
      // Match #123 or PR URL
      const numberMatch = comment.body.match(/#(\d+)/);
      const urlMatch = comment.body.match(/github\.com\/[^\/]+\/[^\/]+\/pull\/(\d+)/);
      if (urlMatch) {
        prNumber = urlMatch[1];
        break;
      }
      if (numberMatch) {
        // Check if this issue number is really a PR
        const possibleNumber = numberMatch[1];
        // Confirm it's a PR
        try {
          const pr = await octokit.pulls.get({
            owner,
            repo,
            pull_number: possibleNumber
          });
          if (pr) {
            prNumber = possibleNumber;
            break;
          }
        } catch (error) {
          // Not a PR, skip
        }
      }
    }

    // Prepare base prompt for ticket summary
    const issuePrompt = `You are an expert GitHub issue analyst. Summarize the ticket below in clear language for QA:\nTitle: ${title}\nBody: ${body}\nLabels: ${labels.map(l => l.name).join(", ")}`;

    // Start building the comment body
    let commentBody = "";

    // First, do the issue summary via GPT
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are an expert GitHub issue analyst. Summarize the ticket in clear language for QA." },
          { role: "user", content: issuePrompt }
        ],
        max_tokens: 300
      });
      const analysis = response.choices[0].message.content;
      commentBody += `LLM QA analysis:\n\n${analysis}\n\n`;
    } catch (error) {
      commentBody += `Failed to generate LLM QA analysis: ${error.message}\n\n`;
    }

    // If PR found, get details and summarize code changes
    if (prNumber) {
      try {
        const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
        const changedFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: prNumber });

        const prTitle = pr.data.title;
        const prBody = pr.data.body;
        const filesList = changedFiles.data.map(f => f.filename).join(", ");

        // Compose a prompt for GPT to summarize code changes
        const prPrompt = `A pull request (#${prNumber}) is associated with this issue. Here are the details:\nPR Title: ${prTitle}\nPR Body: ${prBody}\nFiles changed: ${filesList}\n\nBriefly summarize what the code in this PR does for QA.`;

        const prResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are an expert code reviewer. Briefly summarize what the following pull request's code changes accomplish, in plain language for QA." },
            { role: "user", content: prPrompt }
          ],
          max_tokens: 200
        });

        const prAnalysis = prResponse.choices[0].message.content;
        commentBody += `Associated PR (#${prNumber}) summary:\n\n${prAnalysis}\n\n`;
      } catch (error) {
        commentBody += `Failed to analyze associated PR (#${prNumber}): ${error.message}\n\n`;
      }
    } else {
      commentBody += `No associated pull request found in issue comments.\n\n`;
    }

    // Comment on the issue with the combined analysis
    try {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: commentBody
      });
      console.log(`Commented on Issue #${number}`);
    } catch (error) {
      console.error(`Failed to comment on issue #${number}:`, error);
    }
  }
}

run().catch(console.error);
