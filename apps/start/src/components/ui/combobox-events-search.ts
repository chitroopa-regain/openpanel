import { compareItems, rankItem } from '@tanstack/match-sorter-utils';

const SEPARATOR_REGEX = /[^a-z0-9]+/gi;

export interface EventSearchItem {
  name: string;
}

export function normalizeEventSearchValue(value: string) {
  return value
    .toLowerCase()
    .replace(SEPARATOR_REGEX, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactEventSearchValue(value: string) {
  return normalizeEventSearchValue(value).replace(/\s+/g, '');
}

function hasOrderedTokenPrefixMatch(candidate: string, query: string) {
  const queryTokens = normalizeEventSearchValue(query).split(' ').filter(Boolean);

  if (queryTokens.length === 0) {
    return false;
  }

  const candidateTokens = normalizeEventSearchValue(candidate)
    .split(' ')
    .filter(Boolean);

  let candidateIndex = 0;

  for (const token of queryTokens) {
    let matched = false;

    while (candidateIndex < candidateTokens.length) {
      if (candidateTokens[candidateIndex]?.startsWith(token)) {
        matched = true;
        candidateIndex += 1;
        break;
      }
      candidateIndex += 1;
    }

    if (!matched) {
      return false;
    }
  }

  return true;
}

function getEventSearchScore(candidate: string, query: string) {
  const normalizedCandidate = normalizeEventSearchValue(candidate);
  const normalizedQuery = normalizeEventSearchValue(query);

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedCandidate === normalizedQuery) {
    return 400;
  }

  if (hasOrderedTokenPrefixMatch(candidate, query)) {
    return 300;
  }

  const compactCandidate = compactEventSearchValue(candidate);
  const compactQuery = compactEventSearchValue(query);

  if (compactQuery && compactCandidate.includes(compactQuery)) {
    return 200;
  }

  const ranking = rankItem(normalizedCandidate, normalizedQuery);

  if (ranking.passed) {
    return 100;
  }

  return -1;
}

export function filterEventSearchItems<T extends EventSearchItem>(
  items: T[],
  query: string
) {
  const normalizedQuery = normalizeEventSearchValue(query);

  if (!normalizedQuery) {
    return items;
  }

  return items
    .map((item, index) => {
      const normalizedName = normalizeEventSearchValue(item.name);
      const fuzzyRank = rankItem(normalizedName, normalizedQuery);

      return {
        item,
        index,
        fuzzyRank,
        score: getEventSearchScore(item.name, normalizedQuery),
      };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      const fuzzyComparison = compareItems(left.fuzzyRank, right.fuzzyRank);

      if (fuzzyComparison !== 0) {
        return fuzzyComparison;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.item);
}
