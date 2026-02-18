export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Dev Tasks MCP Server</h1>
      <p>Model Context Protocol server for autonomous coding agent project management.</p>
      <h2>Available Tools (12)</h2>
      <h3>Discovery</h3>
      <ul>
        <li><strong>getBacklog</strong> - Get prioritized task queue from active sprint or backlog</li>
        <li><strong>getBugs</strong> - Get bugs from the Bugs Queue</li>
      </ul>
      <h3>Context</h3>
      <ul>
        <li><strong>getTask</strong> - Full task details with subtasks, epic, sprint context</li>
        <li><strong>getSprint</strong> - Active sprint overview with goals and progress</li>
        <li><strong>getEpic</strong> - Epic details with linked tasks and progress</li>
      </ul>
      <h3>Execution</h3>
      <ul>
        <li><strong>claimTask</strong> - Atomically claim and start a task</li>
        <li><strong>updateTask</strong> - Update task fields, status, links</li>
        <li><strong>manageSubtasks</strong> - Create/update/delete subtasks</li>
      </ul>
      <h3>Creation</h3>
      <ul>
        <li><strong>createTask</strong> - Create new tasks with subtasks</li>
        <li><strong>convertBugToTask</strong> - Convert bug to bugfix task</li>
        <li><strong>createBug</strong> - File a new bug</li>
      </ul>
      <h3>Shipping</h3>
      <ul>
        <li><strong>updateVersion</strong> - Manage versions and link tasks</li>
      </ul>
      <h2>MCP Endpoint</h2>
      <code>/api/mcp</code>
    </main>
  );
}
