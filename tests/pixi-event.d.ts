
declare module PIXI {

	interface IEvent
	{
		type: string;
		content: any;
	}

	export class EventTarget
	{
		addEventListener(type: string, listener: (event: IEvent) => void );
		removeEventListener(type: string, listener: (event: IEvent) => void );
		dispatchEvent(event: IEvent);
	}
	export class ImageLoader extends EventTarget
	{
		constructor(url: string, crossorigin?: boolean);
	}
}
