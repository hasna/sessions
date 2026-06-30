export function appendProjectFilter(
  where: string[],
  params: unknown[],
  value: string,
  alias = "s"
): void {
  const project = value.trim();
  if (!project) return;
  const prefix = alias ? `${alias}.` : "";
  where.push(
    `(${prefix}project_path = ? OR ${prefix}project_name = ? OR ${prefix}project_path LIKE ? ESCAPE '\\' OR ${prefix}project_name LIKE ? ESCAPE '\\')`
  );
  params.push(project, project, `%${escapeLike(project)}%`, `%${escapeLike(project)}%`);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
