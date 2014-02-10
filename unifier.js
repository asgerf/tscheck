var Map = require('./map')

// ----------------------
// 		UNION TYPES
// ----------------------

function unionType(t1, t2) {
	// TODO
}
function lookupOnType(t, prty) {

}

// { type: 'union', members: [] }
function flattenUnion(types) {
	
}

// ----------------------
// 		UNION-FIND
// ----------------------

function Node() {
	this.parent = this
	this.rank = 0
	this.properties = new Map
	this.types = []
}
Node.prototype.rep = function() {
	var p = this.parent
	if (p === this)
		return p
	return this.parent = p.rep()
};

function getNode(e) {
	if (e instanceof Node)
		return e.rep()
	else
		return e.$node ? e.$node.rep() : (e.$node = new Node)
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