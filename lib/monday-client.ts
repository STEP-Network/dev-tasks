const MONDAY_API_URL = "https://api.monday.com/v2";
const API_VERSION = "2024-10";

export async function executeMondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.MONDAY_API_KEY;

  if (!apiKey) {
    throw new Error("MONDAY_API_KEY environment variable is not set");
  }

  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }

  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
      "API-Version": API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Monday API query error: ${JSON.stringify(result.errors)}`);
  }

  return result.data as T;
}
