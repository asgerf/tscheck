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

var bad = good;
