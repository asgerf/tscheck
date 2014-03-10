function good(x) {
	this.x = x;
	this.y = "df";
}
good.prototype.getX = function() {
	return this.x;
}
good.prototype.getY = function() {
	return this.y;
}
good.prototype.getW = function() {
	return this.x;
}

var bad = good;
