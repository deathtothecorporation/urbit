import { GraphNode } from '@urbit/api';
import BigIntOrderedMap from '@urbit/api/lib/BigIntOrderedMap';
import BigIntArrayOrderedMap, {
  arrToString
} from '@urbit/api/lib/BigIntArrayOrderedMap';
import bigInt, { BigInteger } from 'big-integer';
import produce from 'immer';
import _ from 'lodash';
import { reduceState } from '../state/base';
import useGraphState, { GraphState } from '../state/graph';

export const GraphReducer = (json) => {
  const data = _.get(json, 'graph-update', false);

  if (data) {
    reduceState<GraphState, any>(useGraphState, data, [
      keys,
      addGraph,
      removeGraph,
      addNodes,
      removePosts
    ]);
  }
  const loose = _.get(json, 'graph-update-loose', false);
  if(loose) {
    reduceState<GraphState, any>(useGraphState, loose, [addNodesLoose]);
  }

  const flat = _.get(json, 'graph-update-flat', false);
  if (flat) {
    reduceState<GraphState, any>(useGraphState, flat, [addNodesFlat]);
  }

  const thread = _.get(json, 'graph-update-thread', false);
  if (thread) {
    reduceState<GraphState, any>(useGraphState, thread, [addNodesThread]);
  }
};

const addNodesLoose = (json: any, state: GraphState): GraphState => {
  const data = _.get(json, 'add-nodes', false);
  if(data) {
    const { resource: { ship, name }, nodes } = data;
    const resource = `${ship}/${name}`;

    const indices = _.get(state.looseNodes, [resource], {});
    _.forIn(nodes, (node, index) => {
      indices[index] = processNode(node);
    });
    _.set(state.looseNodes, [resource], indices);
  }
  return state;
};

const addNodesFlat = (json: any, state: GraphState): GraphState => {
  const data = _.get(json, 'add-nodes', false);
  if (data) {
    console.log(JSON.stringify(data.nodes))
    console.log(Object.keys(data.nodes).length);

    if (!('flatGraphs' in state)) { return state; }

    const resource = data.resource.ship + '/' + data.resource.name;
    if (!(resource in state.flatGraphs)) {
      state.flatGraphs[resource] = new BigIntArrayOrderedMap();
    }
    const indices = Array.from(Object.keys(data.nodes));

    indices.forEach((index) => {
      if (index.split('/').length === 0) { return; }
      const indexArr = index.split('/').slice(1).map((ind) => bigInt(ind));
      if (indexArr.length === 0) { return state; }

      let node = data.nodes[index];
      node.children = mapifyChildren({});
      state.flatGraphs[resource] =
        state.flatGraphs[resource].set(indexArr, node);
    });

  }
  return state;
};

const addNodesThread = (json: any, state: GraphState): GraphState => {
  const data = _.get(json, 'add-nodes', false);
  if (data) {
    if (!('threadGraphs' in state)) {
      return state;
    }

    const resource = data.resource.ship + '/' + data.resource.name;
    if (!(resource in state.threadGraphs)) {
      state.threadGraphs[resource] = {};
    }

    const indices = Array.from(Object.keys(data.nodes));

    indices.forEach((index) => {
      if (index.split('/').length === 0) { return; }
      const indexArr = index.split('/').slice(1).map((ind) => bigInt(ind));
      if (indexArr.length === 0) { return state; }

      let parentKey = indexArr[0].toString();
      if (!(parentKey in state.threadGraphs[resource])) {
        state.threadGraphs[resource][parentKey] = new BigIntArrayOrderedMap([], true);
      }

      let node = data.nodes[index];
      node.children = mapifyChildren({});
      state.threadGraphs[resource][parentKey] =
        state.threadGraphs[resource][parentKey].set(indexArr, node);
    });

  }
  return state;
};

const keys = (json, state: GraphState): GraphState => {
  const data = _.get(json, 'keys', false);
  if (data) {
    state.graphKeys = new Set(data.map((res) => {
      const resource = res.ship + '/' + res.name;
      return resource;
    }));
  }
  return state;
};

const processNode = (node) => {
  //  is empty
  if (!node.children) {
    return produce<GraphNode>(node, (draft: GraphNode) => {
      draft.children = new BigIntOrderedMap();
    });
  }

  //  is graph
  return produce<GraphNode>(node, (draft: GraphNode) => {
    draft.children = new BigIntOrderedMap<GraphNode>()
      .gas(_.map(draft.children, (item, idx) =>
        [bigInt(idx), processNode(item)] as [BigInteger, any]
      ));
  });
};

const addGraph = (json, state: GraphState): GraphState => {
  const data = _.get(json, 'add-graph', false);
  if (data) {
    if (!('graphs' in state)) {
      state.graphs = {};
    }

    if (!('flatGraphs' in state)) {
      state.flatGraphs = {};
    }

    const resource = data.resource.ship + '/' + data.resource.name;
    state.graphs[resource] = new BigIntOrderedMap();
    state.graphTimesentMap[resource] = {};

    state.graphs[resource] = state.graphs[resource].gas(Object.keys(data.graph).map((idx) => {
      return [bigInt(idx), processNode(data.graph[idx])];
    }));

    state.graphKeys.add(resource);
  }
  return state;
};

const removeGraph = (json, state: GraphState): GraphState => {
  const data = _.get(json, 'remove-graph', false);
  if (data) {
    if (!('graphs' in state)) {
      state.graphs = {};
    }

    if (!('graphs' in state)) {
      state.flatGraphs = {};
    }
    const resource = data.ship + '/' + data.name;
    state.graphKeys.delete(resource);
    delete state.graphs[resource];
  }
  return state;
};

const mapifyChildren = (children) => {
  return new BigIntOrderedMap().gas(
    _.map(children, (node, idx) => {
      idx = idx && idx.startsWith('/') ? idx.slice(1) : idx;
      const nd = { ...node, children: mapifyChildren(node.children || {}) };
      return [bigInt(idx), nd];
    }));
};

const addNodes = (json, state) => {
  const _addNode = (graph, index, node) => {
    //  set child of graph
    if (index.length === 1) {
      return graph.set(index[0], node);
    }

    // set parent of graph
    const parNode = graph.get(index[0]);
    if (!parNode) {
      console.error('parent node does not exist, cannot add child');
      return graph;
    }
    return graph.set(index[0], produce(parNode, (draft) => {
      draft.children = _addNode(draft.children, index.slice(1), node);
    }));
  };

  const _remove = (graph, index) => {
    if (index.length === 1) {
      return graph.delete(index[0]);
    } else {
      const child = graph.get(index[0]);
      if (child) {
        return graph.set(index[0], produce(child, (draft) => {
          draft.children = _remove(draft.children, index.slice(1));
        }));
      }
    }

    return graph;
  };

  const _killByFuzzyTimestamp = (graph, resource, timestamp) => {
    if (state.graphTimesentMap[resource][timestamp]) {
      const index = state.graphTimesentMap[resource][timestamp];

      if (index.split('/').length === 0) { return graph; }
      const indexArr = index.split('/').slice(1).map((ind) => bigInt(ind));

      delete state.graphTimesentMap[resource][timestamp];
      return _remove(graph, indexArr);
    }
    return graph;
  };

  const _removePending = (graph, post, resource) => {
    if (!post.hash) { return graph; }

    graph = _killByFuzzyTimestamp(graph, resource, post['time-sent']);
    graph = _killByFuzzyTimestamp(graph, resource, post['time-sent'] - 1);
    graph = _killByFuzzyTimestamp(graph, resource, post['time-sent'] + 1);
    return graph;
  };

  const data = _.get(json, 'add-nodes', false);
  if (data) {
    if (!('graphs' in state)) { return state; }
    if (!('flatGraphs' in state)) { return state; }
    if (!('threadGraphs' in state)) { return state; }

    const resource = data.resource.ship + '/' + data.resource.name;
    if (!(resource in state.graphs)) {
      state.graphs[resource] = new BigIntOrderedMap();
    }

    if (!(resource in state.graphTimesentMap)) {
      state.graphTimesentMap[resource] = {};
    }

    state.graphKeys.add(resource);

    const indices = Array.from(Object.keys(data.nodes));

    indices.sort((a, b) => {
      const aArr = a.split('/');
      const bArr = b.split('/');
      return aArr.length - bArr.length;
    });

    indices.forEach((index) => {
      let node = data.nodes[index];
      const old = state.graphs[resource].size;
      state.graphs[resource] = _removePending(
        state.graphs[resource],
        node.post,
        resource
      );
      const newSize = state.graphs[resource].size;

      if (index.split('/').length === 0) { return; }
      const indexArr = index.split('/').slice(1).map((ind) => bigInt(ind));
      if (indexArr.length === 0) { return state; }

      if (node.post.pending) {
        state.graphTimesentMap[resource][node.post['time-sent']] = index;
      }

      state.graphs[resource] = _addNode(
        state.graphs[resource],
        indexArr,
        produce(node, (draft) => {
          draft.children = mapifyChildren(draft?.children || {});
        })
      );

      if (resource in state.flatGraphs) {
        node.children = mapifyChildren({});
        state.flatGraphs[resource] =
          state.flatGraphs[resource].set(indexArr, node);
      }

      let threadKey = indexArr[0].toString();
      if (resource in state.threadGraphs &&
          threadKey in state.threadGraphs[resource]) {

        let thread = state.threadGraphs[resource][threadKey];
        if (indexArr.length > 1) {
          let parentKey = indexArr.slice(0, indexArr.length - 1);
          if (thread.has(parentKey)) {
            let isFirstChild =  Array.from(thread.keys()).filter((k) => {
              console.log(k);
              console.log(arrToString(k).indexOf(parentKey));
              return arrToString(k).indexOf(parentKey) !== -1;
            }).length === 0;

            if (isFirstChild) {
              node.children = mapifyChildren({});
              state.threadGraphs[resource][threadKey] =
                state.threadGraphs[resource][threadKey].set(indexArr, node);
            }
          }
        }
      }

      if(newSize !== old) {
        console.log(`${resource}, (${old}, ${newSize}, ${state.graphs[resource].size})`);
      }
    });
  }
  return state;
};

const removePosts = (json, state: GraphState): GraphState => {
  const _remove = (graph, index) => {
    const child = graph.get(index[0]);
    if (index.length === 1) {
        if (child) {
          return graph.set(index[0], {
            post: child.post.hash || '',
            children: child.children
          });
        }
    } else {
      if (child) {
        _remove(child.children, index.slice(1));
        return graph.set(index[0], child);
      } else {
        const child = graph.get(index[0]);
        if (child) {
          return graph.set(index[0], produce((draft) => {
            draft.children = _remove(draft.children, index.slice(1));
          }));
        }
        return graph;
      }
    }
  };

  const data = _.get(json, 'remove-posts', false);
  if (data) {
    const { ship, name } = data.resource;
    const res = `${ship}/${name}`;
    if (!(res in state.graphs)) {
 return state;
}

    data.indices.forEach((index) => {
      if (index.split('/').length === 0) {
 return;
}
      const indexArr = index.split('/').slice(1).map((ind) => {
        return bigInt(ind);
      });
      state.graphs[res] = _remove(state.graphs[res], indexArr);
    });
  }
  return state;
};
