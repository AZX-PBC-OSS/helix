/** A DSN described for a log line: identity, host, port and database — never the password. */
export function describeDsn(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${decodeURIComponent(url.username)}@${url.host}${url.pathname}`;
  } catch {
    return "<unparseable dsn>";
  }
}
