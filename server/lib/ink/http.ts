export interface InkProblem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  retryable: boolean;
}

export function problemResponse(
  request: Request,
  status: number,
  code: string,
  title: string,
  detail: string,
  retryable = false,
): Response {
  const problem: InkProblem = {
    type: `https://inkos.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    detail,
    instance: new URL(request.url).pathname,
    retryable,
  };
  return Response.json(problem, {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

export function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
