
/*
	Node {
		input: Set[Type],
		output: Set[Type]
	}
*/

function TypeSet() {
}
TypeSet.prototype.add = function(typ) {
	var h = canonicalizeType(typ)
	if (h in this)
		return false
	this[h] = typ
	return true
}
TypeSet.prototype.forEach = function(fn) {
	for (var k in this) {
		if (this.hasOwnProperty(k)) {
			fn(this[k])
		}
	}
}
TypeSet.prototype.addAll = function(ts) {
	var ch = false
	for (var k in ts) {
		if (!(k in this)) {
			this[k] = ts[k]
			ch = true
		}
	}
	return ch
}
TypeSet.prototype.propagateMembersTo = function(otherSet, prty) {
	var totalCh = false // true if this set changed
	var iterCh;			// true if changed during current iteration (if otherSet===this)
	do {
		iterCh = false
		for (var k in this) {
			if (this.hasOwnProperty(k)) {
				var t = lookupPrtyOnType(this[k], prty)
				if (t) {
					iterCh |= otherSet.add(k)
				}
			}
		}	
		totalCh |= iterCh
	} while (iterCh && otherSet === this);
	return totalCh
}

// ----------------------
// 		UNION-FIND
// ----------------------

var unode_id = 0
function UNode() {
	this.parent = this
	this.rank = 0
	this.properties = new Map
	this.id = ++unode_id
	this.input = new TypeSet
	this.output = new TypeSet
}
UNode.prototype.rep = function() {
	var p = this.parent
	if (p === this)
		return p
	return this.parent = p.rep()
};
UNode.prototype.getPrty = function(name) {
	var r = this.rep()
	var n = r.properties.get(name)
	if (!n) {
		n = new UNode
		r.properties.put(name, n)
		this.input.propagateMembersTo(n.input, name)
		this.output.propagateMembersTo(n.output, name)
	}
	return n
}
UNode.prototype.unify = function(other) {
	unifier.unify(this, other)
	unifier.complete()
}


function Unifier() {
	this.queue = []
}
Unifier.prototype.unify = function(n1, n2) {
	n1 = n1.rep()
	n2 = n2.rep()
	if (n1 === n2)
		return
	if (n2.rank > n1.rank) {
		var z = n1; n1 = n2; n2 = z; // swap n1/n2 so n1 has the highest rank
	}
	if (n1.rank === n2.rank) {
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
	n1.input.addAll(n2.input)
	n1.output.addAll(n2.output)
	n1.id = Math.min(n1.id, n2.id)
	n2.input = n2.output = n2.properties = null
};
Unifier.prototype.unifyPrty = function(n1, prty, n2) {
	n1 = n1.rep()
	n2 = n2.rep()
	var k = '$' + prty
	var p1 = n1.properties[k]
	if (p1) {
		this.unifyLater(p1, n2)
	} else {
		n1.properties[k] = n2
	}
};
Unifier.prototype.propagateTypes = function(node) {
	node = node.rep()
	node.properties.forEach(function(prty, dst) {
		var ch = false
		ch |= node.input.propagateMembersTo(dst.input, prty)
		ch |= node.output.propagateMembersTo(dst.output, prty)
		if (ch) {
			this.propagateTypes(dst)
		}
	})
}
Unifier.prototype.propagateType = function(node, io, typ) {
	if (!typ)
		return
	node = node.rep()
	if (node[io].add(typ)) {
		node.properties.forEach(function(prty, dst) {
			this.propagateType(dst, io, lookupPrtyOnType(typ, prty))
		})
	}
}

Unifier.prototype.unifyLater = function(n1, n2) {
	if (n1 !== n2) {
		this.queue.push(n1)
		this.queue.push(n2)
	}
}

Unifier.prototype.complete = function() {
	while (this.queue.length > 0) {
		var n1 = this.queue.pop()
		var n2 = this.queue.pop()
		this.unify(n1, n2)
	}
}

var unifier = new Unifier;

/*
	type FunctionNode {
		depth: int
		parameters: UNode[]
		return: UNode
		this: UNode
		calls: CallNode[]
	}
*/

function FunctionNode(depth) {
	this.depth = depth
	this.parameters = []
	this.return = null
	this.this = null
	this.calls = []
}
FunctionNode.prototype.clone = function() {

}

function aliasAnalysis(ast) {
	
	
	
	
}