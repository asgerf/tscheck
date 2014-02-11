var Map = require('./map')


// ----------------------
// 		UNION-FIND
// ----------------------

function Node(id) {
	this.parent = this
	this.rank = 0
	this.properties = new Map
	this.type = null
	this.id = id
}
Node.prototype.rep = function() {
	var p = this.parent
	if (p === this)
		return p
	return this.parent = p.rep()
};

var unifyNodes = []
function getNode(e) {
	if (e instanceof Node)
		return e.rep()
	if (e.$node)
		return e.$node.rep()
	var node = e.$node = new Node(unifyNodes.length)
	unifyNodes.push(node)
	return node
}

function Unifier() {
	this.queue = []
}
Unifier.prototype.unify = function(e1, e2) {
	var n1 = getNode(e1)
	var n2 = getNode(e2)
	if (n1 === n2)
		return
	if (n2.rank > n1.rank) {
		var z = n1; n1 = n2; n2 = z; // swap n1/n2 so n1 has the highest rank
	}
	if (n1.rank > n2.rank) {
		n1.rank++
	}
	n2.parent = n1
	for (var k in n2.properties) {
		if (k[0] !== '$')
			continue
		var p2 = n2.properties[k]
		if (k in n1.properties) {
			var p1 = n1.properties[k]
			this.unifyLater(p1, p2)
		} else {
			n1.properties[k] = p2
		}
	}
	for (var i=0; i<n2.types.length; i++) {
		n1.types.push(n2.types[i])
	}
	n2.properties = null
	n2.types = null
};
Unifier.prototype.unifyPrty = function(e1, prty, e2) {
	var n1 = getNode(e1)
	var n2 = getNode(e2)
	var k = '$' + prty
	var p1 = n1.properties[k]
	if (p1) {
		this.unifyLater(p1, n2)
	} else {
		n1.properties[k] = n2
	}
};
Unifier.prototype.satisfyType = function(e, type) {
	getNode(e).types.push(type)
};

Unifier.prototype.unifyLater = function(n1, n2) {
	if (n1 !== n2) {
		this.queue.push(n1)
		this.queue.push(n2)
	}
}

Unifier.prototype.completeUnification = function() {
	while (this.queue.length > 0) {
		var n1 = this.queue.pop()
		var n2 = this.queue.pop()
		this.unify(n1, n2)
	}
}


// -----------------------------
// 		 TYPE PROPAGATION
// -----------------------------

// Finds strongly connected components in the points-to graph
//
// Adds the following fields to union-find root nodes:
// - $scc: pointer to representative of SCC
// - $components (repr of SCC only): list of members in SCC
//
// Returns the list of representative nodes, topologically sorted
function computeSCCs() {  // see: http://en.wikipedia.org/wiki/Tarjan's_strongly_connected_components_algorithm
	var components = []
	var index = 0
	var stack = []
	for (var i=0; i<unifyNodes.length; i++) {
		var node = unifyNodes[i]
		if (node.rep() === node) {
			if (typeof node.$index !== 'number') {
				scc(node)
			}
		}
	}
	function scc(v) {
		v.$index = index
		v.$lowlink = index
		index++
		stack.push(v)

		for (var k in v.properties) {
			if (k[0] !== '$')
				continue
			var w = v.properties[k].rep()
			if (typeof w.$index !== 'number') {
				scc(w)
				v.$lowlink = Math.min(v.$lowlink, w.$lowlink)
			} else if (w.$onstack) {
				v.$lowlink = Math.min(v.$lowlink, w.$index)
			}
		}

		if (v.$lowlink === v.$index) {
			components.push(v)
			var cmp = v.$component = []
			var w;
			do {
				w = stack.pop()
				cmp.push(w)
				w.$scc = v
			} while (w !== v);
		}
	}
	components.reverse() // reversing this makes it topologically sorted
	return components
}

function UnionType() {
	this.any = false
	this.table = Object.create(null)
}
UnionType.prototype.add = function(t) {
	if (this.any)
		return false
	if (t.type === 'any') {
		this.any = true
		this.table = null
		return true
	}
	var h = canonicalizeType(t)
	if (h in this.table)
		return false
	this.table[h] = t
	return true
}
UnionType.prototype.some = function(f) {
	if (this.any)
		return f({type: 'any'})
	var table = this.table
	for (var k in table) {
		if (f(table[k])) {
			return true
		}
	}
	return false
}
UnionType.prototype.forEach = function(f) {
	if (this.any) {
		f({type: 'any'})
		return
	}
	var table = this.table
	for (var k in table) {
		f(table[k])
	}
}

function propagateTypes() {
	var components = computeSCCs()
	components.forEach(function(c) {
		// propagate round inside component
		var worklist = c.$component.clone()
		while (worklist.length > 0) {
			var node = worklist.pop()
			node.properties.forEach(function(prty, dst) {
				dst = dst.rep()
				if (dst.$scc !== c)
					return
				node.types.forEach(function(t) {
					lookupOnType(t,prty).forEach(function (t2) {
						if (dst.types.add(t2)) {
							worklist.push(dst)
						}
					})
				})
			})
		}
		// propagate outward to successors
		c.$component.forEach(function(node) {
			node.properties.forEach(function(prty, dst) {
				dst = dst.rep()
				if (dst.$scc === c)
					return
				node.types.forEach(function(t) {
					lookupOnType(t,prty).forEach(function(t2) {
						dst.types.add(t2)
					})
				})
			})
		})
	})
}

// Removes consecutive duplicates from `xs` (mutates xs)
function remdup(xs) {
	var shift = 0
	for (var i=1; i<xs.length; ++i) {
		if (xs[i] === xs[i-1]) {
			shift++
		} else if (shift > 0) {
			xs[i - shift] = xs[i]
		}
	}
	xs.length -= shift
}

function coerceTypeToObject(x) {
	switch (x.type) {
		case 'number': return {type: 'reference', name:'Number'}
		case 'string': return {type: 'reference', name:'String'}
		case 'string-const': return {type: 'reference', name:'String'}
		case 'boolean': return {type: 'reference', name:'Boolean'}
		default: return x
	}
}
function lookupOnType(t, name) { // type X string -> type[]
	t = coerceTypeToObject(t)
	if (t.type === 'reference')
		t = resolveTypeRef(t)
	switch (t.type) {
		case 'any': 
			return [{type:'any'}]
		case 'object':
			var prty = t.properties[name]
			if (prty) {
				return [prty.type]
			}
			if (t.numberIndexer !== null && isNumberString(name)) {
				return [t.numberIndexer]
			}
			if (t.stringIndexer !== null) {
				return [t.stringIndexer]
			}
			return []
		case 'enum':
			var enumvals = enum_values.get(t.name)
			if (enumvals.length === 0)
				return [{type: 'any'}]
			var keys = enumvals.map(function(v) {
				v = coerceToObject(v)
				if (v && typeof v === 'object')
					return v.key
				else
					return null // removed by compact below
			}).compact().unique()
			var values = keys.map(function(key) {
				var obj = lookupObject(key)
				var prty = obj.propertyMap.get(name)
				if (prty) {
					return {type: 'value', value: prty.value}
				} else {
					return null // removed by compact below
				}
			}).compact()
			return values
		case 'value':
			var v = coerceToObject(t.value)
			if (v.value && typeof v.value === 'object') {
				var obj = lookupObject(t.value.key)
				var prty = obj.propertyMap.get(name)
				if (prty) {
					return [{type: 'value', value: prty.value}]
				}
			}
			return []
		default:
			return []
	}
}
