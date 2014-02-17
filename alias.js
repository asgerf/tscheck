
// ----------------------
// 		UNION-FIND
// ----------------------

var unode_id = 0
function UNode() {
	this.parent = this
	this.rank = 0
	this.properties = new Map
	this.id = ++unode_id
	this.isTemp = false
	this.depth = Infinity
	this.cloneTarget = null
	this.clonePhase = 0
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
	}
	return n
}
UNode.prototype.assignDepth = function(d) {
	var r = this.rep()
	if (d < r.depth) {
		r.depth = d
	}
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
	n2.properties = null
	n1.id = Math.min(n1.id, n2.id)
	n1.isTemp = n1.isTemp && n2.isTemp
	if (n1.depth != n2.depth) {
		n1.depth = Math.min(n1.depth, n2.depth)
		this.propagateDepth(n1)
	}
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

Unifier.prototype.unifyLater = function(n1, n2) {
	if (n1 !== n2) {
		this.queue.push(n1)
		this.queue.push(n2)
	}
}
Unifier.prototype.propagateDepth = function(n) {
	n = n.rep()
	for (var k in n.properties) {
		var p = n.properties[k].rep()
		if (p.depth > n.depth) {
			p.depth = n.depth
			propagateDepth(p)
		}
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