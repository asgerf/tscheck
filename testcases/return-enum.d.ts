declare enum FontStyle {
	Normal, Bold, Italic
}
declare enum FontSize {
	Small, Large
}

declare function getStyle(): FontStyle;
declare function badStyle(x:number): FontStyle;
declare function bad(): FontStyle;
declare function badConvert(x:FontStyle): FontSize;
