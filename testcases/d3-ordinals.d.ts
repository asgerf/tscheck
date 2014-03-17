declare module d3 {
    export interface ScaleBase {
        /*
        * Construct an ordinal scale.
        */
        ordinal(): OrdinalScale;
        /*
        * Construct an ordinal scale with ten categorical colors.
        */
        category10(): OrdinalScale;
        /*
        * Construct an ordinal scale with twenty categorical colors
        */
        category20(): OrdinalScale;
        /*
        * Construct an ordinal scale with twenty categorical colors
        */
        category20b(): OrdinalScale;
        /*
        * Construct an ordinal scale with twenty categorical colors
        */
        category20c(): OrdinalScale;
        
    }

    export interface Scale {
        (value: any): any;
        domain: {
            (values: any[]): Scale;
            (): any[];
        };
        range: {
            (values: any[]): Scale;
            (): any[];
        };
        copy(): Scale;
    }


    export interface OrdinalScale extends Scale {
        /**
        * Get the range value corresponding to a given domain value.
        *
        * @param value Domain Value
        */
        (value: any): any;
        /**
        * Get or set the scale's input domain.
        */
        domain: {
            /**
            * Set the scale's input domain.
            *
            * @param value The input domain
            */
            (values: any[]): OrdinalScale;
            /**
            * Get the scale's input domain.
            */
            (): any[];
        };
        /**
        * get or set the scale's output range.
        */
        range: {
            /**
            * Set the scale's output range.
            *
            * @param value The output range.
            */
            (values: any[]): OrdinalScale;
            /**
            * Get the scale's output range.
            */
            (): any[];
        };
        rangePoints(interval: any[], padding?: number): OrdinalScale;
        rangeBands(interval: any[], padding?: number, outerPadding?: number): OrdinalScale;
        rangeRoundBands(interval: any[], padding?: number, outerPadding?: number): OrdinalScale;
        rangeBand(): number;
        /**
        * create a new scale from an existing scale..
        */
        copy(): OrdinalScale;
    }

    var scale : ScaleBase;
}

