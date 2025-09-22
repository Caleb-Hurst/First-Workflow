require('dotenv').config();
const { Octokit } = require("@octokit/rest");
const { OpenAI } = require("openai");

const owner = "Caleb-Hurst";
const repo = "First-Workflow";
const label = "needs-test";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function findAssociatedPRNumber(issueNumber) {
  const timeline = await octokit.issues.listEventsForTimeline({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100
  });

  for (const event of timeline.data) {
    if (
      event.event === "cross-referenced" &&
      event.source &&
      event.source.pull_request
    ) {
      if (event.source.pull_request.number) {
        return event.source.pull_request.number;
      }
      if (event.source.issue && event.source.issue.pull_request) {
        return event.source.issue.number;
      }
    }
  }

  const prs = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 100
  });

  for (const pr of prs.data) {
    if (pr.body && pr.body.includes(`#${issueNumber}`)) {
      return pr.number;
    }
  }

  const comments = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 50
  });

  for (const comment of comments.data) {
    const numberMatch = comment.body.match(/#(\d+)/);
    if (numberMatch) {
      const possibleNumber = numberMatch[1];
      try {
        const pr = await octokit.pulls.get({ owner, repo, pull_number: possibleNumber });
        if (pr) return possibleNumber;
      } catch (err) {}
    }
  }
  // No PR found
  return null;
}

async function run() {
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

    let prNumber = await findAssociatedPRNumber(number);

    const issuePrompt = `You are an expert GitHub issue analyst. Summarize the ticket below in clear language for QA:\nTitle: ${title}\nBody: ${body}\nLabels: ${labels.map(l => l.name).join(", ")}`;

    let commentBody = "";

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

    if (prNumber) {
      try {
        const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
        const changedFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: prNumber });

        const prTitle = pr.data.title;
        const prBody = pr.data.body;
        const filesList = changedFiles.data.map(f => f.filename).join(", ");

        // Gather patches (diffs) for all changed files
        const diffs = changedFiles.data
          .filter(f => f.patch)
          .map(f => `File: ${f.filename}\n${f.patch}`)
          .join('\n\n');

        const prPrompt = `A pull request (#${prNumber}) is associated with this issue. Here are the details:\nPR Title: ${prTitle}\nPR Body: ${prBody}\nFiles changed: ${filesList}\nCode changes:\n${diffs}\n\nSummarize what the code in this PR does for QA.`;

        const prResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are an expert code reviewer. Briefly summarize what the following pull request's code changes accomplish, in plain language for QA." },
            { role: "user", content: prPrompt }
          ],
          max_tokens: 400
        });

        const prAnalysis = prResponse.choices[0].message.content;
        commentBody += `Associated PR (#${prNumber}) summary:\n\n${prAnalysis}\n\n`;
      } catch (error) {
        commentBody += `Failed to analyze associated PR (#${prNumber}): ${error.message}\n\n`;
      }
    } else {
      commentBody += `No associated pull request found for this issue.\n\n`;
    }

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
