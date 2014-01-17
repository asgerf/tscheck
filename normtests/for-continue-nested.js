// print every array in `arrays` if it is sorted, ignoring null elements
var arrays = [
	[1, 2, 3],
	[5, null, 6, 3, 2],
	[null, null, 2, null, 7, 8]
];
var xs = [];
outer: for (var i=0; i<arrays.length; i++) {
	var prev = null
	var ys = []
	for (var j=0; j<arrays[i].length; j++) {
		if (arrays[i][j] === null)
			continue;
		if (prev !== null && arrays[i][j] < prev)
			continue outer;
		ys.push(arrays[i][j]);
		prev = arrays[i][j]
	}
	xs.push(ys.join(','))
}
console.log(xs.join('\n'))
