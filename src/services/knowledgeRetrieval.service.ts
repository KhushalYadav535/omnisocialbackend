export interface KnowledgeSnippet {
  category: string;
  question?: string;
  answer: string;
  source: string;
}

export class KnowledgeRetrievalService {
  /**
   * Parse FAQs from string format into structured KnowledgeSnippet array
   */
  static parseFaqs(faqsRaw?: string | null): KnowledgeSnippet[] {
    if (!faqsRaw || !faqsRaw.trim()) {
      return [];
    }

    const snippets: KnowledgeSnippet[] = [];

    // Check if JSON array
    try {
      const parsed = JSON.parse(faqsRaw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.question && item.answer) {
            snippets.push({
              category: item.category || 'FAQ',
              question: item.question,
              answer: item.answer,
              source: 'Brand Standard FAQs (JSON)'
            });
          }
        }
        if (snippets.length > 0) return snippets;
      }
    } catch {
      // Fall through to text/markdown parser
    }

    // Parse Q: ... A: ... lines
    const blocks = faqsRaw.split(/(?=Q:)/i);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const qMatch = trimmed.match(/Q:\s*([^\n\r]+)/i);
      const aMatch = trimmed.match(/A:\s*([\s\S]+)/i);

      if (qMatch && aMatch) {
        snippets.push({
          category: 'FAQ',
          question: qMatch[1].trim(),
          answer: aMatch[1].trim(),
          source: 'Brand Voice FAQs'
        });
      } else if (trimmed.length > 10) {
        snippets.push({
          category: 'Guideline',
          answer: trimmed,
          source: 'Brand Knowledge Base'
        });
      }
    }

    return snippets;
  }

  /**
   * Search knowledge base for snippets relevant to customer query
   */
  static retrieveRelevantKnowledge(
    snippets: KnowledgeSnippet[],
    queryText: string,
    maxSnippets = 4
  ): KnowledgeSnippet[] {
    if (!snippets || snippets.length === 0) {
      return [];
    }

    const lowerQuery = queryText.toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/).filter((t) => t.length > 2);

    // Score snippets based on keyword overlap
    const scored = snippets.map((snippet) => {
      let score = 0;
      const combined = `${snippet.question || ''} ${snippet.answer}`.toLowerCase();

      for (const token of queryTokens) {
        if (combined.includes(token)) {
          score += 2;
        }
      }

      // Exact substring boost
      if (snippet.question && lowerQuery.includes(snippet.question.toLowerCase())) {
        score += 10;
      }

      return { snippet, score };
    });

    // Sort descending by score, take top N
    return scored
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0 || snippets.length <= maxSnippets)
      .slice(0, maxSnippets)
      .map((s) => s.snippet);
  }

  /**
   * Format snippets into structured markdown context for system prompt
   */
  static formatForPrompt(snippets: KnowledgeSnippet[]): string {
    if (!snippets || snippets.length === 0) {
      return 'No specific brand FAQ knowledge items available.';
    }

    return snippets
      .map((s, idx) => {
        if (s.question) {
          return `[Knowledge ${idx + 1}] (${s.category})\nQ: ${s.question}\nA: ${s.answer}`;
        }
        return `[Knowledge ${idx + 1}] (${s.category}): ${s.answer}`;
      })
      .join('\n\n');
  }
}

