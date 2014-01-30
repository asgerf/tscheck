function gcd(x, y) {
	if (y === 0)
		return x
	else
		return gcd(y, x % y)
}
console.log(gcd(8,12))
