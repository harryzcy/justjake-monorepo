import { objectEntries } from '@jitl/util';
import { Client as NotionClient, Logger, LogLevel } from '@notionhq/client';
import {
  GetBlockResponse,
  GetPageResponse,
  GetUserResponse,
  QueryDatabaseParameters,
} from '@notionhq/client/build/src/api-endpoints';
import { debug } from 'debug';

////////////////////////////////////////////////////////////////////////////////
// Debugging.
////////////////////////////////////////////////////////////////////////////////

export const DEBUG = debug('@jitl/notion-api');

// API debugging w/ DEBUG=*
const DEBUG_API = DEBUG.extend('api');
type NotionClientLoggers = { [K in LogLevel]: typeof DEBUG_API };
const DEBUG_API_LEVEL: { [K in LogLevel]: typeof DEBUG_API } = {
  debug: DEBUG_API.extend('debug'),
  info: DEBUG_API.extend('info'),
  warn: DEBUG_API.extend('warn'),
  error: DEBUG_API.extend('error'),
};

export type NotionClientDebugLogger = Logger & NotionClientLoggers;
const logger: Logger = (level, message, extraInfo) => {
  DEBUG_API_LEVEL[level]('%s %o', message, extraInfo);
};
export const NotionClientDebugLogger: NotionClientDebugLogger = Object.assign(
  logger,
  DEBUG_API_LEVEL
);

export {
  /**
   * The official @notionhq/client API Client.
   */
  NotionClient,
};

////////////////////////////////////////////////////////////////////////////////
// API fundamentals.
////////////////////////////////////////////////////////////////////////////////

export type EmptyObject = Record<string, never>;

export interface PaginatedList<T> {
  object: 'list';
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface PaginatedArgs {
  start_cursor?: string;
  page_size?: number;
}

const DEBUG_ITERATE = DEBUG.extend('iterate');

/**
 * Iterate over all results in a paginated list API.
 * @param listFn API to call
 * @param firstPageArgs These arguments are used for each page, with an updated `start_cursor`.
 *
 * ```
 * for await (const block of iteratePaginatedAPI(notion.blocks.children.list, {
 *   block_id: parentBlockId,
 * })) {
 *   // Do something with block.
 * }
 * ```
 */
export async function* iteratePaginatedAPI<Args extends PaginatedArgs, Item>(
  listFn: (args: Args) => Promise<PaginatedList<Item>>,
  firstPageArgs: Args
): AsyncIterableIterator<Item> {
  let next_cursor: string | null | undefined = firstPageArgs.start_cursor;
  let has_more = true;
  let results: Item[] = [];
  let total = 0;
  let page = 0;

  while (has_more) {
    ({ results, next_cursor, has_more } = await listFn({
      ...firstPageArgs,
      start_cursor: next_cursor,
    }));
    page++;
    total += results.length;
    DEBUG_ITERATE(
      '%s: fetched page %s, %s (%s, %s total)',
      listFn.name,
      page,
      next_cursor ? 'done' : 'has more',
      results.length,
      total
    );
    yield* results;
  }
}

/**
 * Gather all an async iterable's items into an array.
 * ```
 * const iterator = iteratePaginatedAPI(notion.blocks.children.list, { block_id: parentBlockId });
 * const blocks = await asyncIterableToArray(iterator);
 * const paragraphs = blocks.filter(block => isFullBlock(block, 'paragraph'))
 * ```
 */
export async function asyncIterableToArray<T>(
  iterable: AsyncIterable<T>
): Promise<Array<T>> {
  const array = [];
  for await (const item of iterable) {
    array.push(item);
  }
  return array;
}

////////////////////////////////////////////////////////////////////////////////
// Pages.
////////////////////////////////////////////////////////////////////////////////

/**
 * A full Notion API page.
 */
export type Page = Extract<GetPageResponse, { parent: unknown }>;

/**
 * The Notion API may return a "partial" page object if your API token can't
 * access the page.
 *
 * This function confirms that all page data is available.
 */
export function isFullPage(page: GetPageResponse): page is Page {
  return 'parent' in page;
}

/**
 * An extension of the Notion API page type that ads a `children` attribute
 * forming a recursive tree of blocks.
 */
export type PageWithChildren = Page & { children: BlockWithChildren[] };

export function isPageWithChildren(
  page: GetPageResponse
): page is PageWithChildren {
  return isFullPage(page) && 'children' in page;
}

////////////////////////////////////////////////////////////////////////////////
// Blocks.
////////////////////////////////////////////////////////////////////////////////

type AnyBlock = Extract<GetBlockResponse, { type: string }>;

/**
 * Type of any block.
 */
export type BlockType = AnyBlock['type'];

/**
 * A full Notion API block.
 */
export type Block<BlockType extends AnyBlock['type'] = AnyBlock['type']> =
  Extract<AnyBlock, { type: BlockType }>;

/**
 * The Notion API may return a "partial" block object if your API token can't
 * access the block.
 *
 * This function confirms that all block data is available.
 */
function isFullBlock(block: GetBlockResponse): block is Block;
/**
 * The Notion API may return a "partial" block object if your API token can't
 * access the block.
 *
 * This function confirms that all block data is available, and the block has
 * type `blockType`.
 */
function isFullBlock<Type extends BlockType>(
  block: GetBlockResponse,
  blockType: Type
): block is Block<Type>;
function isFullBlock<Type extends BlockType>(
  block: GetBlockResponse,
  type?: Type
): block is Block<Type> {
  return 'type' in block && type ? block.type === type : true;
}

type BlockTypeMap = {
  [K in BlockType]: Block<K>;
};

export type BlockDataMap = {
  [K in BlockType]: BlockTypeMap[K] extends { [key in K]: unknown }
    ? // @ts-expect-error "Too complex" although, it works?
      BlockTypeMap[K][K]
    : never;
};

export type AnyBlockData = BlockDataMap[BlockType];

/**
 * Generic way to get a block's data.
 */
export function getBlockData<Type extends BlockType>(
  block: Block<Type>
): BlockDataMap[Type] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (block as any)[block.type];
}

/**
 * An extension of the Notion API block type that adds a `children` attribute
 * forming a recursive tree of blocks.
 */
export type BlockWithChildren<Type extends BlockType = BlockType> =
  Block<Type> & { children: BlockWithChildren[] };

export function isBlockWithChildren(
  block: GetBlockResponse
): block is BlockWithChildren {
  return isFullBlock(block) && 'children' in block;
}

////////////////////////////////////////////////////////////////////////////////
// Block children.
////////////////////////////////////////////////////////////////////////////////

/**
 * Fetch all supported children of a block.
 */
export async function getChildBlocks(
  notion: NotionClient,
  parentBlockId: string
): Promise<Block[]> {
  const blocks: Array<Block> = [];

  for await (const block of iteratePaginatedAPI(notion.blocks.children.list, {
    block_id: parentBlockId,
  })) {
    if (isFullBlock(block)) {
      blocks.push(block);
    }
  }

  return blocks;
}

const DEBUG_CHILDREN = DEBUG.extend('children');

/**
 * Recursively fetch all children of `parentBlockId` as `BlockWithChildren`.
 * This function can be used to fetch an entire page's contents in one call.
 */
export async function getChildBlocksWithChildrenRecursively(
  notion: NotionClient,
  parentId: string
): Promise<BlockWithChildren[]> {
  const blocks = (await getChildBlocks(
    notion,
    parentId
  )) as BlockWithChildren[];
  DEBUG_CHILDREN('parent %s: fetched %s children', parentId, blocks.length);

  if (blocks.length === 0) {
    return [];
  }

  const result = await Promise.all(
    blocks.map(async (block) => {
      if (block.has_children) {
        block.children = await getChildBlocksWithChildrenRecursively(
          notion,
          block.id
        );
      } else {
        block.children = [];
      }
      return block;
    })
  );
  DEBUG_CHILDREN('parent %s: finished descendants', parentId);

  return result;
}

// TODO: remove?
export async function getBlockWithChildren(
  notion: NotionClient,
  blockId: string
): Promise<BlockWithChildren | undefined> {
  const block = (await notion.blocks.retrieve({
    block_id: blockId,
  })) as BlockWithChildren;
  if (!isFullBlock(block)) {
    return undefined;
  }

  if (block.has_children) {
    block.children = await getChildBlocksWithChildrenRecursively(
      notion,
      block.id
    );
  } else {
    block.children = [];
  }

  return block;
}

export function visitChildBlocks(
  blocks: BlockWithChildren[],
  fn: (block: BlockWithChildren) => void
): void {
  for (const block of blocks) {
    visitChildBlocks(block.children, fn);
    fn(block);
  }
}

////////////////////////////////////////////////////////////////////////////////
// Rich text.
////////////////////////////////////////////////////////////////////////////////

/**
 * Notion API rich text. An array of rich text tokens.
 */
export type RichText = Extract<
  Block,
  { type: 'paragraph' }
>['paragraph']['text'];

/**
 * A single token of rich text.
 */
export type RichTextToken = RichText[number];

type AnyMention = Extract<RichTextToken, { type: 'mention' }>;
export type MentionType = AnyMention['mention']['type'];

export type MentionData<Type extends MentionType> = Extract<
  AnyMention['mention'],
  { type: Type }
>;

/**
 * A mention token.
 * (This type doesn't seem to work very well.)
 */
export type Mention<Type extends MentionType = MentionType> = Omit<
  AnyMention,
  'mention'
> & { mention: MentionData<Type> };

/**
 * @returns Plaintext string of rich text.
 */
export function richTextAsPlainText(
  richText: string | RichText | undefined
): string {
  if (!richText) {
    return '';
  }

  if (typeof richText === 'string') {
    return richText;
  }

  return richText
    .map((token) => {
      token.plain_text;
    })
    .join('');
}

type DateMentionData = MentionData<'date'>;

/**
 * Notion date type.
 */
export type DateResponse = DateMentionData['date'];

export function notionDateStartAsDate(date: DateResponse | Date): Date;
export function notionDateStartAsDate(
  date: DateResponse | Date | undefined
): Date | undefined;
export function notionDateStartAsDate(
  date: DateResponse | Date | undefined
): Date | undefined {
  if (!date) {
    return undefined;
  }

  if (date instanceof Date) {
    return date;
  }

  const start = date.start;
  return new Date(start);
}

/**
 * Visit all text tokens in a block or page. Relations are treated as mention
 * tokens. Does not consider children.
 */
export function visitTextTokens(
  object: Block | Page,
  fn: (token: RichTextToken) => void
): void {
  if (object.object === 'page') {
    for (const [, prop] of objectEntries(object.properties)) {
      switch (prop.type) {
        case 'title':
        case 'rich_text':
          getPropertyData(prop).forEach((token) => fn(token));
          break;
        case 'relation':
          getPropertyData(prop).forEach((relation) => {
            const token: RichTextToken = {
              type: 'mention',
              mention: {
                type: 'page',
                page: relation,
              },
              annotations: {
                bold: false,
                code: false,
                color: 'default',
                italic: false,
                strikethrough: false,
                underline: false,
              },
              href: null,
              plain_text: relation.id,
            };
            fn(token);
          });
          break;
      }
    }
  }

  if (object.object === 'block') {
    const blockData = getBlockData(object);
    if ('text' in blockData) {
      blockData.text.forEach(fn);
    }

    if ('caption' in blockData) {
      blockData.caption.forEach(fn);
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// Users.
////////////////////////////////////////////////////////////////////////////////

/**
 * Person or Bot
 */
export type User = GetUserResponse;

/**
 * Person
 */
export type Person = Extract<User, { type: 'person' }>;

/**
 * Bot
 */
export type Bot = Extract<User, { type: 'bot' }>;

////////////////////////////////////////////////////////////////////////////////
// Database queries.
////////////////////////////////////////////////////////////////////////////////

export type Filter = NonNullable<QueryDatabaseParameters['filter']>;
export type PropertyFilter = Extract<Filter, { type?: string }>;
export type CompoundFilter = Exclude<Filter, PropertyFilter>;
export type Sorts = NonNullable<QueryDatabaseParameters['sorts']>;
export type Sort = Sorts[number];

////////////////////////////////////////////////////////////////////////////////
// Properties
////////////////////////////////////////////////////////////////////////////////

type AnyProperty = Page['properties'][string];

export type PropertyType = AnyProperty['type'];

/**
 * A property of a Notion page.
 */
export type Property<Type extends PropertyType = PropertyType> = Extract<
  AnyProperty,
  { type: Type }
>;

type PropertyTypeMap = {
  [K in PropertyType]: Property<K>;
};

export type PropertyDataMap = {
  [K in PropertyType]: PropertyTypeMap[K] extends { [key in K]: unknown }
    ? // @ts-expect-error "Too complex" although, it works?
      PropertyTypeMap[K][K]
    : never;
};

/**
 * Generic way to get a property's data.
 * Suggested usage is with a switch statement on property.type to narrow the
 * result.
 *
 * ```
 * switch (prop.type) {
 *   case 'title':
 *   case 'rich_text':
 *     getPropertyData(prop).forEach((token) => fn(token));
 *     break;
 *   // ...
 * }
 * ```
 */
export function getPropertyData<Type extends PropertyType>(
  property: Property<Type>
): PropertyDataMap[Type] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (property as any)[property.type];
}

/**
 * A pointer to a property in a Notion API page. The property will by looked up
 * by `name`, or `id` if given.
 *
 * The database property in Notion must have the matching `propertyType` to
 * match the pointer. Otherwise, it will be the same as a non-existent property..
 */
export interface PropertyPointer<Type extends PropertyType = PropertyType> {
  type: Type;
  name: string;
  id?: string;
}

/**
 * A pointer to a property in a Notion API page of any property type that has
 * `T` as the property data.
 */
export type PropertyPointerWithOutput<T> = {
  [P in keyof PropertyDataMap]: PropertyDataMap[P] extends T | null
    ? PropertyPointer<P>
    : never;
}[PropertyType];

export function getProperty(
  page: Page,
  { name, id }: Pick<PropertyPointer, 'name' | 'id'>
): Property | undefined {
  const property = page.properties[name];
  if (property && id ? id === property.id : true) {
    return property;
  }

  if (id) {
    return Object.values(page.properties).find(
      (property) => property.id === id
    );
  }

  return undefined;
}

/**
 * Get the value of property `propertyPointer` in `page`.
 * @returns The value of the property, or `undefined` if the property isn't found, or has a different type.
 */
export function getPropertyValue<Type extends PropertyType>(
  page: Page,
  propertyPointer: PropertyPointer<Type>
): PropertyDataMap[Type] | undefined;
/**
 * Get the value of property `propertyPointer` in `page`, transformed by `transform`.
 * @returns The result of `as(propertyValue)`, or `undefined` if the property isn't found or has a different type.
 */
export function getPropertyValue<Type extends PropertyType, T>(
  page: Page,
  propertyPointer: PropertyPointer<Type>,
  transform: (propertyValue: PropertyDataMap[Type]) => T
): T | undefined;
/**
 * Get the value of property `propertyPointer` in `page`.
 * @returns The value of the property, or `undefined` if the property isn't found, or has a different type.
 */
export function getPropertyValue<T>(
  page: Page,
  propertyPointer: PropertyPointerWithOutput<T>
): T | undefined;
/**
 * Get the value of property `propertyPointer` in `page`, transformed by `transform`.
 * @returns The result of `as(propertyValue)`, or `undefined` if the property isn't found or has a different type.
 */
export function getPropertyValue<P, T>(
  page: Page,
  propertyPointer: PropertyPointerWithOutput<P>,
  transform: (propertyValue: P) => T
): T | undefined;
export function getPropertyValue<P, T>(
  page: Page,
  propertyPointer: PropertyPointerWithOutput<P>,
  transform?: (propertyValue: P) => T
): T | undefined {
  const property = getProperty(page, propertyPointer);
  if (property && property.type === propertyPointer.type) {
    const propertyValue = (property as any)[propertyPointer.type];
    if (propertyValue !== undefined) {
      return transform ? transform(propertyValue) : propertyValue;
    }
  }
}
