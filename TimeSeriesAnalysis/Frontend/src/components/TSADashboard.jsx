import React, { useEffect, useState } from 'react'
import * as d3 from "d3"
import TextBox from './TextBox'
import RadioButton from './RadioButton'

let controls = {
    freq: 'None',
    period: 0,
    lags: 1,
    bins: 10,
}

let feedback = "";

let dataProcessed = {
    base:[], time_base: [], trend:[], 
    seasonal:[], time_decomposed:[], 
    residual:[], stationary: [], time_stationary: [],
    acf:[], pacf:[], corr_ci:[], corr_lags:[], 
}

const isNumeric = (str) => {
    /** Returns true if the string is a number and false otherwise. */
    return !isNaN(str);
}

const TSADashboard = ({ data, frequency, period, lags, title }) => {
    const [changedDataLine, setChangedDataLine] = useState(0);
    const [changedDataHist, setChangedDataHist] = useState(0);
    const [changedDataCorr, setChangedDataCorr] = useState(0);
    const [changedDataBox, setChangedDataBox] = useState(0);
    const [changedDataNumSum, setChangedDataNumSum] = useState(0);
    const [numDiff, setNumDiff] = useState(0);
    const [selectedLineType, setSelectedLineType] = useState('base');
    const [statusMessage, setStatusMessage] = useState("");

    const handleTextBoxChange = (id) => {
        feedback = "";
        const textBox = d3.select(`#${id}`).select('input');
        const textBoxType = id.split('-')[2];
        const val = textBox.property("value");
        if (sanityCheckControls(textBoxType, val)) {
            if (textBoxType == 'freq') controls[textBoxType] = val;
            if (textBoxType == 'period' || textBoxType == 'lags' || textBoxType == 'bins') controls[textBoxType] = parseInt(val);  
            textBox.attr('style', 'border: 2px solid green');
        } else {
            if (textBoxType == 'freq') controls.freq = frequency;
            if (textBoxType == 'period') controls.period = period;
            if (textBoxType == 'lags') controls.lags = lags;
            if (textBoxType == 'bins') controls.bins = 10;
            textBox.attr('style', 'border: 2px solid red');
        }
    }

    const handleApply = (e) => {
        feedback = "";
        ['freq', 'period', 'lags', 'bins'].forEach(tb => {
            d3.select(`#text-box-${tb}`).select('input').property("value", "").attr('style', 'border:none');
        });
        // Update data.
        updateDataProcessed();
    }

    const sanityCheckControls = (textBoxType, val) => {
        if (textBoxType == 'freq') return typeof val == String && val.length > 0 && val.slice(0, 1) != 0;
        if (textBoxType == 'period' || textBoxType == 'lags') return isNumeric(val) && val > 0 && val <= Math.floor(data.data.length/2);
        if (textBoxType == 'bins') return isNumeric(val) && val
        return false
    }

    const handleLineTypeSelection = (e) => {
        const value = e.currentTarget.value;
        setSelectedLineType(prevVal => value);
    }

    const updateDataProcessed = async () => {
        // Base data.
        dataProcessed.base = data.data;
        dataProcessed.time_base = data.time;

        // Decompose data into trend, seasonal and residual components.
        let decomposed = await fetch('http://127.0.0.1:8001/tsa/decompose/', {
            method: 'POST',
            body: JSON.stringify({"data": data, "freq": controls.freq, "period": controls.period, "model_type": "additive"}),
            headers: {'Content-Type':'application/json'}
        })
        decomposed = await decomposed.json();
        if (decomposed.message.includes('Failure')) {
            feedback += decomposed.message;
        }
        decomposed = decomposed.data;
        dataProcessed.time_decomposed = decomposed.time;
        dataProcessed.trend = decomposed.trend;
        dataProcessed.seasonal = decomposed.seasonal;
        dataProcessed.residual = decomposed.residual;

        // Check stationarity and do decomposition (multiple times
        // if required) to make data stationary.
        let dataStationary = data;
        let stationarity;
        let diff;
        while (true) {
            // Check data stationarity.
            stationarity = await fetch('http://127.0.0.1:8001/tsa/stationarity/', {
                method: 'POST',
                body: JSON.stringify({"data": dataStationary.data}),
                headers: {'Content-Type':'application/json'}
            });
            stationarity = await stationarity.json();
            if (stationarity.message.includes('Failure')) {
                feedback += stationarity.message;
                break; // If there was a failure, exit loop.
            }
            if (stationarity.data.is_stationary == 1) break; // If stationary, exit loop.
            else {  // If not stationary, make stationary by differencing.
                diff = await fetch('http://127.0.0.1:8001/tsa/first_difference/', {
                    method: 'POST',
                    body: JSON.stringify({"data": dataStationary, "freq": controls.freq}),
                    headers: {'Content-Type':'application/json'}
                });
                diff = await diff.json();
                if (diff.message.includes('Failure')) {
                    feedback += diff.message;
                    break;
                }
                dataStationary = diff.data;
                setNumDiff(prevVal => prevVal + 1);
            }
        }
        dataProcessed.stationary = dataStationary.data;
        dataProcessed.time_stationary = dataStationary.time;

        // Get Autocorrelation and Partial Autocorrelation information.
        let correlations = await fetch('http://127.0.0.1:8001/tsa/correlation/', {
            method: 'POST',
            body: JSON.stringify({"data": data, "freq": controls.freq, "lags": controls.lags}),
            headers: {'Content-Type':'application/json'}
        })
        correlations = await correlations.json();
        if (correlations.message.includes('Failure')) {
            feedback += correlations.message;
        }
        correlations = correlations.data;
        dataProcessed.acf = correlations.autocorrelation;
        dataProcessed.pacf = correlations.partial_autocorrelation;
        dataProcessed.corr_lags = correlations.lag;
        dataProcessed.corr_ci = correlations.confidence_interval;
        
        // Reset system feedback to user.
        if (feedback.length > 0) {
            setStatusMessage(feedback);
            setTimeout(() => setStatusMessage(prevVal => ""), 5000);
        }

        // Trigger plot updates.
        setChangedDataLine(prevVal => 1 - prevVal);
        setChangedDataCorr(prevVal => 1 - prevVal);
        setChangedDataNumSum(prevVal => 1 - prevVal);
        setChangedDataHist(prevVal => 1 - prevVal);
    }

    const plotLineData = () => {
        // Get appropriate x axis and y axis data.
        let x;
        let y;
        if (selectedLineType == 'base') {
            y = dataProcessed.base;
            x = dataProcessed.time_base;
        } else if (selectedLineType == 'trend') {
            y = dataProcessed.trend;
            x = dataProcessed.time_decomposed;
        } else if (selectedLineType == 'seasonal') {
            y = dataProcessed.seasonal;
            x = dataProcessed.time_decomposed;
        } else if (selectedLineType == 'residual') {
            y = dataProcessed.residual;
            x = dataProcessed.time_decomposed;
        } else { // selectedLineType == 'stationary'
            y = dataProcessed.stationary;
            x = dataProcessed.time_stationary;
        }
        x = x.map(d => d3.isoParse(d));

        // Define plot elements.
        const svg = d3.select('#svg-line');
        let dataToPlot = [];
        for (let i = 0; i < x.length; i++) dataToPlot.push({'x': x[i], 'y': y[i]});
        const widthSvg = Number(svg.style('width').replace('px', ''));
        const heightSvg = Number(svg.style('height').replace('px', ''));
        const margins = {left: 65, top: 20, right: 20, bottom: 65};
        const widthPlot = widthSvg - margins.left - margins.right;
        const heightPlot = heightSvg - margins.top - margins.bottom;
        const gPlot = svg.selectAll('.group-plot')
                        .data(['g'])
                        .join('g')
                        .attr('class', 'group-plot')
                        .attr('width', widthPlot)
                        .attr('height', heightPlot)
                        .attr('transform', `translate(${margins.left}, ${margins.top})`);
        const gXAxis = gPlot.selectAll('.group-x-axis')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'group-x-axis')
                            .attr('transform', `translate(${0}, ${heightPlot})`);
        const gYAxis = gPlot.selectAll('.group-y-axis')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'group-y-axis');
        const time_range = d3.extent(x);
        const scaleX = d3.scaleTime()
                        .domain(time_range)
                        .range([0, widthPlot]);
        const scaleY = d3.scaleLinear()
                        .domain(d3.extent(y))
                        .range([heightPlot, 0]);
        gXAxis.transition()
            .duration(1000)
            .call(d3.axisBottom(scaleX));
        gYAxis.transition()
            .duration(1000)
            .call(d3.axisLeft(scaleY));
        gXAxis.selectAll('.axis-label')
            .data([
                time_range[0] && time_range[1] ?
                `TIME (${time_range[0].toDateString()} - ${time_range[1].toDateString()})`:
                "TIME"
            ])
            .join('text')
            .attr('class', 'axis-label')
            .text(d => d)
            .attr("x", widthSvg/2-38)
            .attr("y", 50)
            .attr('fill', 'black')
            .attr('font-style', 'italic');
        gYAxis.selectAll('.axis-label')
            .data(['VALUES'])
            .join('text')
            .attr('class', 'axis-label')
            .text(d => d)
            .attr("x", -1*heightSvg/3)
            .attr("y", -50)
            .attr('fill', 'black')
            .attr('font-style', 'italic')
            .attr('transform', 'rotate(-90)');
        gPlot.selectAll('.path-line')
            .data([d3.line()(dataToPlot.map(d => [scaleX(d3.isoParse(d.x)), scaleY(d.y)]))])
            .join("path")
            .attr('class', 'path-line')
            .attr("fill", "none")
            .attr("stroke", "blue")
            .attr("stroke-width", 1.5)
            .transition()
            .duration(1000)
            .attr("d", d => d);
    }

    const plotHistData = () => {
        // Adding data to histogram.
        const bin = d3.bin()
                    .thresholds(controls.bins)
                    .value(d => d);
        const buckets = bin(dataProcessed.base);
        // Setting up axes.
        const svg = d3.select('#svg-hist')
        const widthSvg = Number(svg.style('width').replace('px', ''));
        const heightSvg = Number(svg.style('height').replace('px', ''));
        const margins = {left: 50, top: 20, right: 20, bottom: 50};
        const widthPlot = widthSvg - margins.left - margins.right;
        const heightPlot = heightSvg - margins.top - margins.bottom;
        const gPlot = svg.selectAll('.group-plot')
                        .data(['g'])
                        .join('g')
                        .attr('class', 'group-plot')
                        .attr('width', widthPlot)
                        .attr('height', heightPlot)
                        .attr('transform', `translate(${margins.left}, ${margins.top})`);
        const gXAxis = gPlot.selectAll('.group-x-axis')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'group-x-axis')
                            .attr('transform', `translate(${0}, ${heightPlot})`);;
        const gYAxis = gPlot.selectAll('.group-y-axis')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'group-y-axis');
        const scaleX = d3.scaleLinear()
                        .domain([buckets[0].x0, buckets[buckets.length - 1].x1])
                        .range([0, widthPlot]);
        const scaleY = d3.scaleLinear()
                        .domain([0, d3.max(buckets, (d) => d.length)])
                        .range([heightPlot,0]);
        gXAxis.call(d3.axisBottom(scaleX));
        gYAxis.call(d3.axisLeft(scaleY));
        gXAxis.selectAll('.axis-label')
            .data([`VALUES (bin width = ${buckets[0].x1 - buckets[0].x0})`])
            .join('text')
            .attr('class', 'axis-label')
            .text(d => d)
            .attr("x", widthSvg/2-38)
            .attr("y", 40)
            .attr('fill', 'black')
            .attr('font-style', 'italic');
        gYAxis.selectAll('.axis-label')
            .data(['FREQUENCY'])
            .join('text')
            .attr('class', 'axis-label')
            .text(d => d)
            .attr("x", -1*heightSvg/3)
            .attr("y", -35)
            .attr('fill', 'black')
            .attr('font-style', 'italic')
            .attr('transform', 'rotate(-90)');
        // Adding bars.
        gPlot.selectAll('.bar')
            .data(buckets)
            .join("rect")
            .attr('class', 'bar')
            .attr('fill', 'blue')
            .attr("x", (d) => scaleX(d.x0)+1)
            .attr("y", (d) => scaleY(d.length))
            .attr("height", (d) => scaleY(0) - scaleY(d.length))
            .transition()
            .duration(1000)
            .attr("width", (d) => scaleX(d.x1) - scaleX(d.x0)-1);
    }

    const plotCorrData = () => {
        // Prepare data.
        let dataToPlot = [];
        for (let i = 0; i < dataProcessed.acf.length; i++) dataToPlot.push({
            'x': dataProcessed.corr_lags[i], 
            'y_acf': dataProcessed.acf[i],
            'y_pacf': dataProcessed.pacf[i],
            'ci_pos': dataProcessed.corr_ci[i],
            'ci_neg': -1*dataProcessed.corr_ci[i]
        });

        // Set up plot elements.
        const svg = d3.select('#svg-corr');
        const widthSvg = Number(svg.style('width').replace('px', ''));
        const heightSvg = Number(svg.style('height').replace('px', ''));
        const margins = {left: 50, top: 20, right: 20, bottom: 50};
        const widthPlot = widthSvg - margins.left - margins.right;
        const heightPlot = heightSvg - margins.top - margins.bottom;
        const gPlot = svg.selectAll('.group-plot')
                        .data(['g'])
                        .join('g')
                        .attr('class', 'group-plot')
                        .attr('width', widthPlot)
                        .attr('height', heightPlot)
                        .attr('transform', `translate(${margins.left}, ${margins.top})`);
        const gXAxis = gPlot.selectAll('.group-x-axis')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'group-x-axis')
                            .attr('transform', `translate(${0}, ${heightPlot})`);
        const gYAxis = gPlot.selectAll('.group-y-axis')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'group-y-axis');
        const scaleX = d3.scaleLinear()
                        .domain([0, d3.max(dataProcessed.corr_lags)])
                        .range([0, widthPlot]);
        const scaleY = d3.scaleLinear()
                        .domain(d3.extent(
                            dataProcessed.acf
                            .concat(dataProcessed.pacf)
                            .concat(dataProcessed.corr_ci)
                            .concat(dataProcessed.corr_ci.map(d => -1*d))
                        ))
                        .range([heightPlot, 0]);
        gXAxis.transition()
            .duration(1000)
            .call(d3.axisBottom(scaleX))
            .attr('transform', `translate(${0}, ${scaleY(0)})`);
        gYAxis.transition()
            .duration(1000)
            .call(d3.axisLeft(scaleY));
        gXAxis.selectAll('.axis-label')
            .data(["LAG"])
            .join('text')
            .attr('class', 'axis-label')
            .text(d => d)
            .attr("x", widthSvg/2-38)
            .attr("y", 40)
            .attr('fill', 'black')
            .attr('font-style', 'italic');
        gYAxis.selectAll('.axis-label')
            .data(['CORRELATION'])
            .join('text')
            .attr('class', 'axis-label')
            .text(d => d)
            .attr("x", -1*heightSvg/3)
            .attr("y", -35)
            .attr('fill', 'black')
            .attr('font-style', 'italic')
            .attr('transform', 'rotate(-90)');
        // Add ACF Line.
        const gLinesAcf = gPlot.selectAll('.lines-acf')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'lines-acf');
        gLinesAcf.selectAll('.line')
                .data(dataToPlot)
                .join('path')
                .attr('class', 'line')
                .attr('d', d => {
                    return `M ${scaleX(d.x)} ${scaleY(0)} V ${scaleY(d.y_acf)}`;
                })
                .style('stroke-width', 2)
                .style('stroke', 'red')
                .style('opacity', '0.6');
        // Add PACF Line.
        const gLinesPacf = gPlot.selectAll('.lines-pacf')
                                .data(['g'])
                                .join('g')
                                .attr('class', 'lines-pacf');

        gLinesPacf.selectAll('.line')
            .data(dataToPlot)
            .join('path')
            .attr('class', 'line')
            .attr('d', d => `M ${scaleX(d.x)} ${scaleY(0)} V ${scaleY(d.y_pacf)}`)
            .style('stroke-width', 5)
            .style('stroke', 'green')
            .style('opacity', '0.6');
        // Add Confidence Interval Lines.
        
        const gLinesCi = gPlot.selectAll('.lines-ci')
                            .data(['g'])
                            .join('g')
                            .attr('class', 'lines-ci');
        const lineCiPos = d3.line()
                        .x((d) => scaleX(d.x))
                        .y((d) => scaleY(d.ci_pos));
        const lineCiNeg = d3.line()
                        .x((d) => scaleX(d.x))
                        .y((d) => scaleY(d.ci_neg));
        gLinesCi.selectAll('.line-pos')
                .data(dataToPlot)
                .join('path')
                .attr('class', 'line-pos')
                .attr('d', lineCiPos(dataToPlot))
                .style('stroke-width', 2)
                .style('stroke', 'blue');
        gLinesCi.selectAll('.line-neg')
                .data(dataToPlot)
                .join('path')
                .attr('class', 'line-neg')
                .attr('d', lineCiNeg(dataToPlot))
                .style('stroke-width', 2)
                .style('stroke', 'blue');
    }
    
    useEffect(() => {
        // Set user controls.
        controls.freq = frequency;
        controls.period = period;
        controls.lags = lags;
        handleApply();
    }, []);

    useEffect(() => {
        plotLineData();
    }, [changedDataLine, selectedLineType]);

    useEffect(() => {
        plotHistData()
    }, [changedDataHist]);

    useEffect(() => {
        plotCorrData()
    }, [changedDataCorr]);
    
    return (
        <div>
            {/* Title. */}
            <div className='text-3xl p-5 text-center'>{title}</div>
            <div className='grid grid-rows-3 grid-cols-3 p-5 gap-5'>
                <div id='controls'>
                    <div className='text-center flex justify-center gap-5'> {/* Apply button. */}
                        <div className='font-bold min-h-full flex flex-row items-center'>CONTROLS</div>
                        <button className='py-2 px-5 text-center rounded-full text-sm font-bold bg-blue-500 text-white hover:bg-blue-600' onClick={handleApply}>
                            APPLY
                        </button>
                    </div>
                    <TextBox label={'Frequency'} placeholder={controls.freq} id="text-box-freq" onChange={() => handleTextBoxChange('text-box-freq')} isEditable={false} />
                    <TextBox label={'Period'} placeholder={controls.period} id="text-box-period" onChange={() => handleTextBoxChange('text-box-period')} isEditable={true} />
                    <TextBox label={'Lags'} placeholder={controls.lags} id="text-box-lags" onChange={() => handleTextBoxChange('text-box-lags')} isEditable={true} />   
                    <TextBox label={'Bins'} placeholder={controls.bins} id="text-box-bins" onChange={() => handleTextBoxChange('text-box-bins')} isEditable={true} />    
                    <div className={statusMessage.includes('Success') ? 'text-green-600' : 'text-red-600'}>{statusMessage}</div>
                </div>
                <div id='line' className='col-span-2'>
                    <p>Line Plot</p>
                    <svg id='svg-line' className='w-full h-72 bg-slate-200'></svg>
                    <div className='flex gap-5 justify-between'>
                        <RadioButton label={'Base'} id="radio-base" name="linetype" value="base" selected={selectedLineType == 'base'} uponClick={handleLineTypeSelection} />
                        <RadioButton label={'Trend'} id="radio-trend" name="linetype" value="trend" selected={selectedLineType == 'trend'} uponClick={handleLineTypeSelection} />
                        <RadioButton label={'Seasonal'} id="radio-seasonal" name="linetype" value="seasonal" selected={selectedLineType == 'seasonal'} uponClick={handleLineTypeSelection} />
                        <RadioButton label={'Residual'} id="radio-residual" name="linetype" value="residual" selected={selectedLineType == 'residual'} uponClick={handleLineTypeSelection} />
                        <RadioButton label={'Stationary'} id="radio-stationary" name="linetype" value="stationary" selected={selectedLineType == "stationary"} uponClick={handleLineTypeSelection} />
                    </div>
                </div>
                <div id='num_sum'>
                    Number Summery
                </div>
                <div id='hist' className='col-span-2'>
                    Histogram Plot
                    <svg id='svg-hist' className='w-full h-72 bg-slate-200'></svg>
                </div>
                <div id='box'>
                    Box Plot
                    <svg id='svg-box' className='w-full h-72 bg-slate-200'></svg>
                </div>
                <div id='corr' className='col-span-2'>
                    <font color='red'>ACF</font> & <font color='green'>PACF</font> Plot
                    <svg id='svg-corr' className='w-full h-72 bg-slate-200'></svg>
                </div>
            </div>
        </div>
    )
}

export default TSADashboard