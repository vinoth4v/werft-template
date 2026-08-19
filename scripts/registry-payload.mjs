#!/usr/bin/env node
/**
 * Build the payload this app posts to the Werft registry: its werft.json,
 * plus a summary of its knowledge graph when one is committed.
 *
 * Writes JSON to stdout. Used by .github/workflows/registry-upsert.yml, which
 * previously posted werft.json verbatim.
 *
 * The graph half is best-effort by design: a missing, unreadable or malformed
 * graphify-out/graph.json prints a warning to stderr and emits the werft.json
 * payload unchanged. An app must never fall off the wall because a
 * visualisation could not be built.
 *
 * Bounds below mirror apps/web/src/registry/graph-summary.ts in the
 * marketplace, which validates what arrives. They are duplicated rather than
 * imported for the same reason werftAppPayloadSchema is: an app repo is not a
 * workspace member of the marketplace.
 */

import { readFileSync } from "node:fs"

const MAX_HUBS = 8
const MAX_SAMPLE_NODES = 150
const MAX_SAMPLE_EDGES = 600

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

/**
 * Reduce a full graphify graph to something a browser can draw.
 *
 * The sample keeps the most-connected nodes rather than the first N: degree is
 * what makes a node worth drawing, and an arbitrary slice of a file-ordered
 * list would show whatever happens to sort first.
 */
export function summarise(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const links = Array.isArray(graph.links) ? graph.links : (graph.edges ?? [])
  if (nodes.length === 0) return null

  const degree = new Map()
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1)
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1)
  }

  const communities = new Set()
  for (const node of nodes) {
    if (node.community !== undefined && node.community !== null) communities.add(node.community)
  }

  const ranked = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))

  const hubs = ranked.slice(0, MAX_HUBS).map((node) => ({
    label: String(node.label ?? node.id).slice(0, 120),
    degree: degree.get(node.id) ?? 0,
  }))

  const sampled = ranked.slice(0, MAX_SAMPLE_NODES)
  const indexById = new Map(sampled.map((node, i) => [node.id, i]))

  const sampleEdges = []
  for (const link of links) {
    const a = indexById.get(link.source)
    const b = indexById.get(link.target)
    // Only edges with both ends in the sample: a dangling endpoint has
    // nowhere to be drawn, and the receiver rejects out-of-range indices.
    if (a === undefined || b === undefined || a === b) continue
    sampleEdges.push([a, b])
    if (sampleEdges.length >= MAX_SAMPLE_EDGES) break
  }

  return {
    nodes: nodes.length,
    edges: links.length,
    communities: communities.size,
    ...(typeof graph.built_at_commit === "string" && graph.built_at_commit !== ""
      ? { builtFrom: graph.built_at_commit.slice(0, 64) }
      : {}),
    hubs,
    sample: {
      nodes: sampled.map((node) => ({
        label: String(node.label ?? node.id).slice(0, 120),
        community: Number.isInteger(node.community) ? node.community : 0,
        degree: degree.get(node.id) ?? 0,
      })),
      edges: sampleEdges,
    },
  }
}

function main() {
  const payload = readJson("werft.json")

  try {
    const summary = summarise(readJson("graphify-out/graph.json"))
    if (summary) {
      payload.graph = summary
      process.stderr.write(
        `graph summary: ${summary.nodes} nodes, ${summary.edges} edges, ` +
          `${summary.communities} communities (sending ${summary.sample.nodes.length} nodes, ` +
          `${summary.sample.edges.length} edges)\n`,
      )
    } else {
      process.stderr.write("graphify-out/graph.json has no nodes — sending werft.json only\n")
    }
  } catch (error) {
    process.stderr.write(`no graph summary (${error.message}) — sending werft.json only\n`)
  }

  process.stdout.write(JSON.stringify(payload))
}

// Only when run as a script. Importing this file (the summariser is tested
// against the receiver's schema) must not read files or write to stdout.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
