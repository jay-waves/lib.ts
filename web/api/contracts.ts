import { z } from 'zod';

export const apiErrorSchema = z.object({ error: z.string() }).passthrough();

export const treeNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  absolutePath: z.string().optional(),
  type: z.enum(['directory', 'file']),
  modified: z.string(),
  transportStream: z.boolean().optional(),
  get children(): z.ZodOptional<z.ZodArray<typeof treeNodeSchema>> {
    return z.array(treeNodeSchema).optional();
  },
});
export type TreeNode = z.infer<typeof treeNodeSchema>;

export const treeSchema = z.object({
  name: z.string(),
  absolutePath: z.string(),
  children: z.array(treeNodeSchema),
});
export type FileTree = z.infer<typeof treeSchema> & { revision: string | null };

const bookmarkLine = z.number().int().positive().max(4294967295).optional();
const bookmarkPage = z.object({ index: z.number().int().nonnegative().max(4294967295), x: z.number().finite(), y: z.number().finite() }).optional();
export const bookmarkSchema = z.object({ path: z.string(), line: bookmarkLine, page: bookmarkPage, updatedAt: z.string() });
export const bookmarksResponseSchema = z.object({ bookmarks: z.array(bookmarkSchema) });
export type Bookmark = z.infer<typeof bookmarkSchema>;

export const setBookmarkSchema = z.object({ path: z.string(), bookmarked: z.boolean(), line: bookmarkLine, page: bookmarkPage });

export const recentFilesResponseSchema = z.object({
  recent: z.array(z.string()),
  visitedAt: z.record(z.string(), z.string()).default({}),
});
export type RecentFilesResponse = z.infer<typeof recentFilesResponseSchema>;

export const directoryEntrySchema = z.object({ name: z.string(), path: z.string() });
export const directoryListingSchema = z.object({
  path: z.string(),
  name: z.string(),
  parent: z.string().nullable(),
  directories: z.array(directoryEntrySchema),
  hostname: z.string().min(1),
  rootPath: z.string(),
});
export type DirectoryListing = z.infer<typeof directoryListingSchema>;

export const openDirectoryResponseSchema = z.object({ ok: z.literal(true) });

export const repositoryMetadataSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  root: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  url: z.string(),
  apiUrl: z.string(),
});
export type RepositoryMetadata = z.infer<typeof repositoryMetadataSchema>;

export const repositoriesResponseSchema = z.object({
  repos: z.array(repositoryMetadataSchema),
  defaultRepoId: z.string().nullable().optional(),
});

export const searchFacetSchema = z.object({ value: z.string(), count: z.number().int().nonnegative() });
export const searchResponseSchema = z.object({
  query: z.string(),
  textQuery: z.string(),
  scope: z.string(),
  searchId: z.string(),
  engine: z.string(),
  truncated: z.boolean(),
  total: z.number().int().nonnegative(),
  matchCount: z.number().int().nonnegative(),
  files: z.array(z.object({
    path: z.string(),
    language: z.string(),
    matchCount: z.number().int().nonnegative(),
    snippets: z.array(z.object({
      lines: z.array(z.object({
        number: z.number().int().positive(),
        text: z.string(),
        clipped: z.boolean(),
        ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
      })),
    })),
    snippetsTruncated: z.boolean(),
  })),
  nextOffset: z.number().int().nonnegative().nullable(),
  facets: z.object({ languages: z.array(searchFacetSchema), paths: z.array(searchFacetSchema) }),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const gitStatusSchema = z.object({
  repository: z.boolean(),
  branch: z.string(),
  changes: z.array(z.object({
    path: z.string(),
    status: z.string(),
    originalPath: z.string().optional(),
  })),
});
export type GitStatus = z.infer<typeof gitStatusSchema>;

export const gitDiffResponseSchema = z.object({
  path: z.string(),
  originalPath: z.string().optional(),
  conflict: z.boolean(),
  clean: z.boolean().optional(),
  sections: z.array(z.object({
    id: z.string(),
    label: z.string(),
    binary: z.boolean().optional(),
    tooLarge: z.boolean().optional(),
    hunks: z.array(z.object({
      header: z.string(),
      lines: z.array(z.object({
        kind: z.enum(['add', 'delete', 'context', 'note']),
        text: z.string(),
        oldLine: z.number().int().positive().nullable(),
        newLine: z.number().int().positive().nullable(),
      })),
    })),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    metadata: z.array(z.string()),
  })),
});
export type GitDiffResponse = z.infer<typeof gitDiffResponseSchema>;

export const treeRevisionEventSchema = z.object({ revision: z.string().regex(/^\d+$/) });
export const documentConnectedEventSchema = z.object({
  modified: z.string(), assets: z.record(z.string(), z.string().nullable()),
});
export const assetsChangedEventSchema = z.object({ paths: z.array(z.string()) });

export const treeEvents = {
  connected: treeRevisionEventSchema,
  tree: treeRevisionEventSchema,
} as const;

export const documentEvents = {
  connected: documentConnectedEventSchema,
  document: z.object({}).passthrough(),
  assets: assetsChangedEventSchema,
} as const;
