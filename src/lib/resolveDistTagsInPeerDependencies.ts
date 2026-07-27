import semver from 'semver'
import { type Index } from '../types/IndexType.ts'
import { type Options } from '../types/Options.ts'
import { type Version } from '../types/Version.ts'
import { type VersionSpec } from '../types/VersionSpec.ts'
import getPackageManager from './getPackageManager.ts'

/** Matches a bare npm dist-tag such as `next` or `insiders`. npm rejects tag names that parse as semver, so range syntax and wildcards are excluded. */
const DIST_TAG = /^[a-z][a-z0-9._-]*$/i

/** Splits a range into its `||`-separated comparator sets. */
const splitRange = (spec: VersionSpec): string[] => spec.split('||').map(part => part.trim())

/** Returns the dist-tags used as comparator sets in a range, e.g. `>=3.0.0 || insiders` -> `['insiders']`. */
export const parseDistTags = (spec: VersionSpec): string[] =>
  semver.validRange(spec) ? [] : splitRange(spec).filter(part => DIST_TAG.test(part) && !semver.validRange(part))

/**
 * Replaces the dist-tags in a range with the versions they point to, e.g.
 * `>=3.0.0 || insiders` -> `>=3.0.0 || 0.0.0-insiders.a86e601`. Returns the range unchanged if the
 * result is still not something semver understands.
 */
export const replaceDistTags = (spec: VersionSpec, distTags: Index<Version>): VersionSpec => {
  const resolved = splitRange(spec)
    .map(part => (Object.hasOwn(distTags, part) ? distTags[part] : part))
    .join(' || ')
  return semver.validRange(resolved) ? resolved : spec
}

/**
 * Replaces npm dist-tags in peer dependency ranges with the versions they point to.
 *
 * semver cannot parse a dist-tag, so a range like `>=3.0.0 || insiders` is unusable as a whole and
 * every upgrade is reported as incompatible. Only ranges that semver does not already understand
 * cost an extra registry request.
 */
async function resolveDistTagsInPeerDependencies(
  peerDependencies: Index<Index<VersionSpec>>,
  options: Options,
): Promise<Index<Index<VersionSpec>>> {
  const packageManager = getPackageManager(options, options.packageManager)
  if (!packageManager.getDistTags) return peerDependencies

  // fetch each peer package's dist-tags at most once
  const distTagsByPackage: Index<Promise<Index<Version>>> = {}

  const entries = await Promise.all(
    Object.entries(peerDependencies).map(async ([pkg, peers]) => {
      const resolvedPeers = await Promise.all(
        Object.entries(peers).map(async ([peer, spec]) => {
          // git urls and catalog: references make npm return peer deps that are not version specs
          if (typeof spec !== 'string' || parseDistTags(spec).length === 0) return [peer, spec] as const
          // a peer that is unpublished or on an unreachable registry is left as-is
          const distTags = await (distTagsByPackage[peer] ??= packageManager.getDistTags!(peer, options).catch(
            () => ({}),
          ))
          return [peer, replaceDistTags(spec, distTags)] as const
        }),
      )
      return [pkg, Object.fromEntries(resolvedPeers)] as const
    }),
  )

  return Object.fromEntries(entries)
}

export default resolveDistTagsInPeerDependencies
