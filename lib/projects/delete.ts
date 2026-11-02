export interface ProjectDeleteResponse {
  data: { id: string } | null;
  error: { code?: string; message?: string } | null;
}

/** A zero-row response or lost response is not a confirmed deletion. */
export async function confirmProjectDeletion(
  id: string,
  request: () => PromiseLike<ProjectDeleteResponse>,
): Promise<{ confirmed: boolean; error?: string }> {
  try {
    const { data, error } = await request();
    if (!error && data?.id === id) return { confirmed: true };
    if (error?.code === '23503') {
      return { confirmed: false, error: 'This project is linked to other records and cannot be deleted. Review those records first.' };
    }
  } catch {
    // The server may have committed before the response was lost.
  }
  return { confirmed: false, error: 'Project deletion was not confirmed. Refresh and check the project list before retrying.' };
}
