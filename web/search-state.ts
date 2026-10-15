import type { SearchResponse } from './api/contracts';

type PageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string };

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | {
      status: 'ready';
      result: SearchResponse;
      page: PageState;
    };

export type SearchAction =
  | { type: 'search-start' }
  | { type: 'search-idle' }
  | { type: 'search-success'; result: SearchResponse }
  | { type: 'search-error'; error: string }
  | { type: 'page-start'; searchId: string }
  | { type: 'page-success'; searchId: string; result: SearchResponse }
  | { type: 'page-error'; searchId: string; error: string };

export const initialSearchState: SearchState = { status: 'idle' };

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case 'search-start':
      return { status: 'loading' };
    case 'search-idle':
      return initialSearchState;
    case 'search-success':
      return { status: 'ready', result: action.result, page: { status: 'idle' } };
    case 'search-error':
      return { status: 'error', error: action.error };
    case 'page-start':
      return state.status === 'ready' && state.result.searchId === action.searchId
        && state.result.nextOffset !== null && state.page.status !== 'loading'
        ? { ...state, page: { status: 'loading' } }
        : state;
    case 'page-success':
      if (state.status !== 'ready' || state.page.status !== 'loading' || state.result.searchId !== action.searchId) return state;
      if (action.result.searchId !== action.searchId) {
        return { ...state, page: { status: 'error', error: 'Search snapshot changed. Retry the search.' } };
      }
      return {
        status: 'ready',
        result: { ...action.result, files: [...state.result.files, ...action.result.files] },
        page: { status: 'idle' },
      };
    case 'page-error':
      if (state.status !== 'ready' || state.page.status !== 'loading' || state.result.searchId !== action.searchId) return state;
      return { ...state, page: { status: 'error', error: action.error } };
  }
}
