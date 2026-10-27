// @ts-check

/**
 * Client minimal de l'API REST GitLab v4, limité à la relecture d'une MR.
 */
class GitLabClient {
  /**
   * @param {string} instanceUrl ex. `https://gitlab.com`
   * @param {() => Promise<string>} getAccessToken token OAuth ou PAT (scope `api`), relu à chaque
   *   appel pour suivre le renouvellement du token OAuth
   * @param {() => Promise<void>} invalidateAccessToken oublie un token refusé (401), pour que le
   *   prochain `getAccessToken` relance la connexion
   */
  constructor(instanceUrl, getAccessToken, invalidateAccessToken) {
    this.instanceUrl = instanceUrl;
    this.getAccessToken = getAccessToken;
    this.invalidateAccessToken = invalidateAccessToken;
  }

  /**
   * Un 401 (token révoqué ou expiré côté GitLab) relance une fois la connexion avant d'échouer.
   * @param {string} method
   * @param {string} path chemin relatif à `/api/v4`
   * @param {unknown} [body]
   * @returns {Promise<{ data: any, nextPage: string | null }>}
   */
  async request(method, path, body) {
    let response = await this.fetchWithToken(method, path, body);
    if (response.status === 401) {
      await this.invalidateAccessToken();
      response = await this.fetchWithToken(method, path, body);
    }
    if (!response.ok) {
      throw new Error(`GitLab ${method} ${path} : ${response.status} ${await response.text()}`);
    }
    const text = await response.text();
    return {
      data: text ? JSON.parse(text) : undefined,
      nextPage: response.headers.get('x-next-page'),
    };
  }

  /** @param {string} method @param {string} path @param {unknown} [body] */
  async fetchWithToken(method, path, body) {
    return fetch(`${this.instanceUrl}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getAccessToken()}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * Toutes les pages d'une liste.
   * @param {string} path
   * @returns {Promise<any[]>}
   */
  async requestAllPages(path) {
    const items = [];
    const separator = path.includes('?') ? '&' : '?';
    let page = '1';
    while (page) {
      const { data, nextPage } = await this.request(
        'GET',
        `${path}${separator}per_page=100&page=${page}`
      );
      items.push(...data);
      page = nextPage ?? '';
    }
    return items;
  }

  /** @param {string} projectPath @param {number} iid */
  mergeRequestPath(projectPath, iid) {
    return `/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`;
  }

  async getCurrentUser() {
    return (await this.request('GET', '/user')).data;
  }

  /** @param {string} projectPath @param {string} branch */
  async findOpenMergeRequest(projectPath, branch) {
    const query = new URLSearchParams({ source_branch: branch, state: 'opened' });
    const { data } = await this.request(
      'GET',
      `/projects/${encodeURIComponent(projectPath)}/merge_requests?${query}`
    );
    return data[0];
  }

  /** @param {string} projectPath @param {number} iid */
  async getMergeRequest(projectPath, iid) {
    return (await this.request('GET', this.mergeRequestPath(projectPath, iid))).data;
  }

  /** @param {string} projectPath @param {number} iid */
  listDiscussions(projectPath, iid) {
    return this.requestAllPages(`${this.mergeRequestPath(projectPath, iid)}/discussions`);
  }

  /**
   * @param {string} projectPath @param {number} iid @param {string} body
   * @param {object} [position] sans position, discussion générale de la MR
   */
  async createDiscussion(projectPath, iid, body, position) {
    const path = `${this.mergeRequestPath(projectPath, iid)}/discussions`;
    return (await this.request('POST', path, { body, position })).data;
  }

  /** @param {string} projectPath @param {number} iid @param {string} discussionId @param {string} body */
  async addNote(projectPath, iid, discussionId, body) {
    const path = `${this.mergeRequestPath(projectPath, iid)}/discussions/${discussionId}/notes`;
    return (await this.request('POST', path, { body })).data;
  }

  /**
   * @param {string} projectPath @param {number} iid @param {string} discussionId
   * @param {number} noteId @param {string} body
   */
  async updateNote(projectPath, iid, discussionId, noteId, body) {
    const path = `${this.mergeRequestPath(projectPath, iid)}/discussions/${discussionId}/notes/${noteId}`;
    return (await this.request('PUT', path, { body })).data;
  }

  /** @param {string} projectPath @param {number} iid @param {string} discussionId @param {number} noteId */
  async deleteNote(projectPath, iid, discussionId, noteId) {
    const path = `${this.mergeRequestPath(projectPath, iid)}/discussions/${discussionId}/notes/${noteId}`;
    await this.request('DELETE', path);
  }

  /** @param {string} projectPath @param {number} iid @param {string} discussionId @param {boolean} resolved */
  async setResolved(projectPath, iid, discussionId, resolved) {
    const path = `${this.mergeRequestPath(projectPath, iid)}/discussions/${discussionId}?resolved=${resolved}`;
    await this.request('PUT', path);
  }

  /** Brouillons de review de l'utilisateur connecté. @param {string} projectPath @param {number} iid */
  listDraftNotes(projectPath, iid) {
    return this.requestAllPages(`${this.mergeRequestPath(projectPath, iid)}/draft_notes`);
  }

  /**
   * @param {string} projectPath @param {number} iid
   * @param {{ note: string, position?: object, in_reply_to_discussion_id?: string }} draft sans
   *   position ni discussion, brouillon de commentaire général
   */
  async createDraftNote(projectPath, iid, draft) {
    return (
      await this.request('POST', `${this.mergeRequestPath(projectPath, iid)}/draft_notes`, draft)
    ).data;
  }

  /** @param {string} projectPath @param {number} iid @param {number} draftId @param {string} note */
  async updateDraftNote(projectPath, iid, draftId, note) {
    const path = `${this.mergeRequestPath(projectPath, iid)}/draft_notes/${draftId}`;
    return (await this.request('PUT', path, { note })).data;
  }

  /** @param {string} projectPath @param {number} iid @param {number} draftId */
  async deleteDraftNote(projectPath, iid, draftId) {
    await this.request(
      'DELETE',
      `${this.mergeRequestPath(projectPath, iid)}/draft_notes/${draftId}`
    );
  }

  /** Publie tous les brouillons d'un coup. @param {string} projectPath @param {number} iid */
  async publishDraftNotes(projectPath, iid) {
    await this.request(
      'POST',
      `${this.mergeRequestPath(projectPath, iid)}/draft_notes/bulk_publish`
    );
  }

  /** @param {string} projectPath @param {number} iid */
  async getApprovals(projectPath, iid) {
    return (await this.request('GET', `${this.mergeRequestPath(projectPath, iid)}/approvals`)).data;
  }

  /** @param {string} projectPath @param {number} iid @param {boolean} isApproved */
  async setApproved(projectPath, iid, isApproved) {
    const action = isApproved ? 'approve' : 'unapprove';
    await this.request('POST', `${this.mergeRequestPath(projectPath, iid)}/${action}`);
  }
}

module.exports = { GitLabClient };
